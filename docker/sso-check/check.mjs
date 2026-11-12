// Checks the shop's identity provider against the MVP-2 design (arun-mfe-platform/docs/mvp-2-sso.md).
// Runs inside Docker on the edge and idp networks, through ../sso-check.sh. A browser (Chromium) logs in
// on Keycloak's own page as the real shell-fes client; servers' calls go to Keycloak inside Docker, as the
// units' servers will.
//
//   node check.mjs            every check
//   node check.mjs --quick    without the 6-minute expired-ID-token logout check
//   node check.mjs --roles    only print every unit's roles and grants (used around importer re-runs)

import { randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import { createRemoteJWKSet, jwtVerify, decodeJwt, decodeProtectedHeader, CompactEncrypt, generateKeyPair, SignJWT } from 'jose';
import { chromium } from 'playwright';

const PUBLIC_ISSUER = 'https://shop.test:8443/realms/shop';
const INTERNAL = 'http://keycloak:8080';
const CALLBACK = 'https://shop.test/auth/callback';
const LOGGED_OUT = 'https://shop.test/auth/logged-out';
const UNITS = ['shell', 'catalog', 'cart'];
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const args = new Set(process.argv.slice(2));

const results = [];
function record(id, ok, title, detail = '') {
  results.push({ id, ok, title, detail });
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO';
  console.log(`${mark}  ${id.padEnd(3)} ${title}${detail ? `\n       ${detail}` : ''}`);
}
async function check(id, title, fn) {
  try {
    const detail = await fn();
    record(id, true, title, detail ?? '');
  } catch (error) {
    record(id, false, title, error?.message ?? String(error));
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --- IdP metadata, as a unit's server will read it ------------------------------------------------

// Discovery is fetched inside Docker. Keycloak's back-channel endpoints (token, userinfo, JWKS) then
// point inside Docker, while the issuer and front-channel endpoints stay public. openid-client's own
// discovery() would refuse the internal URL, because the issuer differs from it, so the metadata is
// fetched and its issuer checked here.
async function metadata() {
  const response = await fetch(`${INTERNAL}/realms/shop/.well-known/openid-configuration`);
  expect(response.ok, `discovery answered ${response.status}`);
  const document = await response.json();
  expect(document.issuer === PUBLIC_ISSUER, `issuer is ${document.issuer}`);
  return document;
}

function configuration(server, clientId, secret) {
  const config = new client.Configuration(server, clientId, secret);
  client.allowInsecureRequests(config); // back channel is plain HTTP inside Docker
  return config;
}

// --- Browser login as shell-fes -----------------------------------------------------------------

async function startSignIn(config) {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: CALLBACK,
    scope: 'openid',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url, verifier, state, nonce };
}

// Records the callback URL with its code. Playwright cannot intercept the target of a redirect, so the
// request still reaches the shop, which (until phase 2) just serves the Shell's page there.
async function catchCallbacks(context) {
  const callbacks = [];
  context.on('request', (request) => {
    if (request.url().startsWith(CALLBACK)) callbacks.push(request.url());
  });
  return callbacks;
}

// The browser's request to the callback, with the code. Since phase 2 the Shell FES answers that
// address and the page moves on at once, so the request is waited for, not the address.
function toCallback(page, timeout = 30_000) {
  return page.waitForRequest((request) => request.url().startsWith(CALLBACK), { timeout });
}

async function fillLogin(page, username) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(env('TEST_USER_PASSWORD'));
  await page.locator('#kc-login').click();
}

// The callback for this attempt: its own state. Other callbacks are the Shell FES's own logins.
async function finishSignIn(config, attempt, callbacks) {
  const callbackUrl = callbacks.find((url) => new URL(url).searchParams.get('state') === attempt.state);
  if (!callbackUrl) throw new Error('no callback for this login attempt');
  return client.authorizationCodeGrant(config, new URL(callbackUrl), {
    pkceCodeVerifier: attempt.verifier,
    expectedState: attempt.state,
    expectedNonce: attempt.nonce,
  });
}

async function login(browser, config, username) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const callbacks = await catchCallbacks(context);
  const page = await context.newPage();
  const attempt = await startSignIn(config);
  await page.goto(attempt.url.href);
  const back = toCallback(page);
  await fillLogin(page, username);
  await back;
  const tokens = await finishSignIn(config, attempt, callbacks);
  return { context, page, tokens };
}

// --- Service access tokens and the admin API ------------------------------------------------------

async function serviceToken(server, clientId, secret, scope) {
  const tokens = await client.clientCredentialsGrant(configuration(server, clientId, secret), scope ? { scope } : {});
  return tokens.access_token;
}

async function admin(token, path) {
  const response = await fetch(`${INTERNAL}/admin/realms/shop${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok, `GET ${path} answered ${response.status}`);
  return response.json();
}

async function bootstrapAdminToken() {
  const response = await fetch(`${INTERNAL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: env('KEYCLOAK_ADMIN_USER'),
      password: env('KEYCLOAK_ADMIN_PASSWORD'),
    }),
  });
  expect(response.ok, `admin login answered ${response.status}`);
  return (await response.json()).access_token;
}

// Every client, its roles, and every user's and service account's client roles: what an importer
// re-run must leave unchanged.
async function rolesSnapshot() {
  const token = await bootstrapAdminToken();
  const clients = (await admin(token, '/clients?max=200')).filter((c) => !c.clientId.match(/^(account|admin-cli|broker|realm-management|security-admin-console|account-console)$/));
  const snapshot = {};
  for (const c of clients) {
    const roles = (await admin(token, `/clients/${c.id}/roles`)).map((r) => r.name).sort();
    snapshot[`client ${c.clientId}`] = roles;
  }
  const users = await admin(token, '/users?max=200&briefRepresentation=true');
  for (const c of clients) {
    if (c.serviceAccountsEnabled) {
      const account = await admin(token, `/clients/${c.id}/service-account-user`);
      users.push(account);
    }
  }
  // Effective roles (direct and through groups) on the shop's clients and realm-management, and groups.
  const watched = [...clients, ...(await admin(token, '/clients?clientId=realm-management'))];
  for (const u of users) {
    const granted = [];
    for (const c of watched) {
      const roles = (await admin(token, `/users/${u.id}/role-mappings/clients/${c.id}/composite`)).map((r) => r.name);
      const shown = c.clientId === 'realm-management' ? roles.filter((r) => r === 'view-users') : roles;
      if (shown.length) granted.push(`${c.clientId}: ${shown.sort().join(', ')}`);
    }
    const groups = (await admin(token, `/users/${u.id}/groups`)).map((g) => g.path).sort();
    snapshot[`user ${u.username}`] = [...granted.sort(), `groups: ${groups.join(', ')}`];
  }
  return snapshot;
}

// --- Checks ---------------------------------------------------------------------------------------

async function main() {
  if (args.has('--roles')) {
    console.log(JSON.stringify(await rolesSnapshot(), null, 2));
    return;
  }

  let server;
  await check('1', 'Discovery inside Docker reports the public issuer; keys are reachable inside Docker', async () => {
    server = await metadata();
    expect(new URL(server.jwks_uri).host === 'keycloak:8080', `jwks_uri is ${server.jwks_uri}`);
    expect(new URL(server.token_endpoint).host === 'keycloak:8080', `token_endpoint is ${server.token_endpoint}`);
    expect(new URL(server.authorization_endpoint).origin === 'https://shop.test:8443', `authorization_endpoint is ${server.authorization_endpoint}`);
    return `issuer ${server.issuer}; jwks ${server.jwks_uri}; authorize ${server.authorization_endpoint}; end session ${server.end_session_endpoint}`;
  });
  if (!server) return;

  const jwks = createRemoteJWKSet(new URL(server.jwks_uri));
  const shellFes = configuration(server, 'shell-fes', env('SHELL_FES_SECRET'));
  const browser = await chromium.launch();

  let alice;
  let bob;
  try {
    alice = await login(browser, shellFes, 'alice');
    bob = await login(browser, shellFes, 'bob');
    record('', null, 'Logged in alice and bob through Keycloak\'s page as shell-fes; ID tokens checked by openid-client');
  } catch (error) {
    record('', false, 'Browser login', error.message);
    await browser.close();
    return;
  }

  await check('2', 'alice\'s lightweight access token: only the expected claims, signed by the realm\'s key', async () => {
    const { payload } = await jwtVerify(alice.tokens.access_token, jwks, { issuer: PUBLIC_ISSUER });
    const expected = ['sub', 'sid', 'iss', 'exp', 'iat', 'jti', 'azp', 'aud', 'typ'];
    const extra = Object.keys(payload).filter((k) => !expected.includes(k));
    const missing = expected.filter((k) => !(k in payload));
    expect(missing.length === 0, `missing ${missing.join(', ')}`);
    const aud = [].concat(payload.aud);
    for (const a of ['shell-backend', 'catalog-backend', 'cart-backend']) expect(aud.includes(a), `aud lacks ${a}: ${aud}`);
    expect(payload.azp === 'shell-fes', `azp is ${payload.azp}`);
    for (const k of ['email', 'name', 'preferred_username', 'realm_access', 'resource_access']) {
      expect(!(k in payload), `carries ${k}`);
    }
    return `claims: ${Object.keys(payload).join(', ')}; aud: ${aud.join(', ')}; other claims: ${extra.join(', ') || 'none'}`;
  });

  await check('3', 'bob (no Catalog role) has no catalog-backend in aud', async () => {
    const aud = [].concat(decodeJwt(bob.tokens.access_token).aud);
    expect(!aud.includes('catalog-backend'), `aud: ${aud}`);
    return `aud: ${aud.join(', ')}`;
  });

  await check('4', 'Claim typ: Bearer for access, ID for ID, Refresh for refresh tokens', async () => {
    const types = {
      access: decodeJwt(alice.tokens.access_token).typ,
      id: decodeJwt(alice.tokens.id_token).typ,
      refresh: decodeJwt(alice.tokens.refresh_token).typ,
    };
    expect(types.access === 'Bearer' && types.id === 'ID' && types.refresh === 'Refresh', JSON.stringify(types));
    const header = JSON.parse(Buffer.from(alice.tokens.access_token.split('.')[0], 'base64url'));
    return `${JSON.stringify(types)}; access token header typ: ${header.typ}`;
  });

  // Check 5 runs after check 6, which gets the backends' tokens.

  const backendTokens = {};
  await check('6', 'Each backend\'s service access token reads the user and its own roles by sub', async () => {
    const sub = decodeJwt(alice.tokens.access_token).sub;
    const lines = [];
    for (const unit of UNITS) {
      const secret = env(`${unit.toUpperCase()}_BACKEND_SECRET`);
      const token = await serviceToken(server, `${unit}-backend`, secret, 'kc-admin-api');
      backendTokens[unit] = await serviceToken(server, `${unit}-backend`, secret);
      const user = await admin(token, `/users/${sub}`);
      for (const f of ['id', 'username', 'firstName', 'lastName', 'email', 'emailVerified', 'enabled']) {
        expect(f in user, `${unit}: user lacks ${f}`);
      }
      // view-users cannot look up a client's internal ID, but it reads the user's groups with their
      // role names by clientId: the unit's roles are those its own groups grant.
      const groups = await admin(token, `/users/${sub}/groups?briefRepresentation=false`);
      const roles = groups.flatMap((g) => g.clientRoles?.[`${unit}-backend`] ?? []);
      expect(roles.length > 0, `${unit}: no roles through groups`);
      lines.push(`${unit}: ${roles.join(', ')}`);
    }
    return `user fields include id, username, firstName, lastName, email, emailVerified, enabled; roles by unit: ${lines.join('; ')}`;
  });

  // The FES gate asks its backend's /me (decision after phase 1: Keycloak refuses lightweight tokens at
  // /userinfo). The backend answers from the admin API with its own token: the user's session is still
  // live (the token's sid), the user is enabled, and the unit's roles.
  await check('5', 'Gate data for /me, by sub and sid with view-users only: live session, enabled, unit roles', async () => {
    const adminToken = await serviceToken(server, 'catalog-backend', env('CATALOG_BACKEND_SECRET'), 'kc-admin-api');
    const lines = [];
    for (const [name, session] of [['alice', alice], ['bob', bob]]) {
      const { sub, sid } = decodeJwt(session.tokens.access_token);
      const sessions = await admin(adminToken, `/users/${sub}/sessions`);
      expect(sessions.some((x) => x.id === sid), `${name}: sid ${sid} not among ${sessions.map((x) => x.id)}`);
      const user = await admin(adminToken, `/users/${sub}`);
      const groups = await admin(adminToken, `/users/${sub}/groups?briefRepresentation=false`);
      const roles = groups.flatMap((g) => g.clientRoles?.['catalog-backend'] ?? []);
      lines.push(`${name}: session live, enabled ${user.enabled}, Catalog roles [${roles.join(', ')}]`);
    }
    expect(lines[1].endsWith('[]'), 'bob has Catalog roles');
    return `${lines.join('; ')} → alice 200, bob 403`;
  });

  await check('7', 'Service tokens carry their grants: shop-ops → shop-router ops; cart-backend → Catalog API role', async () => {
    const ops = decodeJwt(await serviceToken(server, 'shop-ops', env('SHOP_OPS_SECRET')));
    expect(ops.resource_access?.['shop-router']?.roles?.includes('ops'), `shop-ops: ${JSON.stringify(ops.resource_access)}`);
    expect([].concat(ops.aud).includes('shop-router'), `shop-ops aud: ${ops.aud}`);
    const cart = decodeJwt(backendTokens.cart ?? (await serviceToken(server, 'cart-backend', env('CART_BACKEND_SECRET'))));
    expect(cart.resource_access?.['catalog-backend']?.roles?.includes('catalog-api:read-products'), `cart-backend: ${JSON.stringify(cart.resource_access)}`);
    expect([].concat(cart.aud).includes('catalog-backend'), `cart-backend aud: ${cart.aud}`);
    expect(![].concat(cart.aud).some((a) => a.includes('/admin/')), `a token for other backends carries the admin API audience: ${cart.aud}`);
    return `shop-ops aud ${[].concat(ops.aud).join(', ')}; cart-backend aud ${[].concat(cart.aud).join(', ')}, azp ${cart.azp}; no admin API audience without asking for kc-admin-api`;
  });

  // Check 8 (importer re-runs) is driven by sso-check.sh around --roles.

  await check('9', 'The same refresh token works twice (rotation off)', async () => {
    const first = await client.refreshTokenGrant(shellFes, alice.tokens.refresh_token);
    const second = await client.refreshTokenGrant(shellFes, alice.tokens.refresh_token);
    expect(first.access_token && second.access_token, 'no access token');
    expect(second.id_token, 'refresh returned no ID token');
    return 'both refreshes returned new access and ID tokens';
  });

  await check('10', 'Two tabs: login started in both, finished in one, then submitted in the other', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const callbacks = await catchCallbacks(context);
    const [first, second] = [await context.newPage(), await context.newPage()];
    const [a1, a2] = [await startSignIn(shellFes), await startSignIn(shellFes)];
    await first.goto(a1.url.href);
    await second.goto(a2.url.href);
    const firstBack = toCallback(first);
    await fillLogin(first, 'alice');
    await firstBack;
    await finishSignIn(shellFes, a1, callbacks);
    let outcome;
    try {
      const secondBack = toCallback(second, 10_000);
      await fillLogin(second, 'alice');
      await secondBack;
      await finishSignIn(shellFes, a2, callbacks);
      outcome = 'the second tab completed its own login, with its own state';
    } catch {
      const text = (await second.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160);
      outcome = `the second tab did not complete: "${text}" at ${second.url()}`;
      // A fresh start in that tab, as the Shell FES does when a callback fails, must succeed at once.
      const a3 = await startSignIn(shellFes);
      const thirdBack = toCallback(second, 10_000);
      await second.goto(a3.url.href);
      await thirdBack;
      await finishSignIn(shellFes, a3, callbacks);
      outcome += '; a fresh login in that tab then succeeded without a form (session already there)';
    }
    await context.close();
    return outcome;
  });

  let ended;
  await check('12', 'Logout with only client_id shows Keycloak\'s confirmation page', async () => {
    const session = await login(browser, shellFes, 'bob');
    const url = new URL(server.end_session_endpoint);
    url.search = new URLSearchParams({ client_id: 'shell-fes', post_logout_redirect_uri: LOGGED_OUT }).toString();
    await session.page.goto(url.href);
    const confirm = session.page.locator('#kc-logout');
    expect(await confirm.isVisible(), `no confirmation; at ${session.page.url()}`);
    const back = session.page.waitForRequest((request) => request.url().startsWith(LOGGED_OUT));
    await confirm.click();
    await back;
    await expectRefreshFails(session.tokens.refresh_token);
    await expectSessionGone(session.tokens.access_token);
    ended = decodeJwt(session.tokens.access_token);
    await session.context.close();
    return 'confirmation shown; after confirming, redirected, refresh failed and the sid is gone from the user\'s sessions';
  });

  await check('13', 'Token sizes, raw and encrypted as cookie values (dir + A256GCM, base64url)', async () => {
    const key = randomBytes(32);
    const sizes = {};
    for (const [name, token] of Object.entries({ access: alice.tokens.access_token, refresh: alice.tokens.refresh_token, id: alice.tokens.id_token })) {
      const encrypted = await new CompactEncrypt(new TextEncoder().encode(token)).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key);
      sizes[name] = { raw: token.length, encrypted: encrypted.length };
    }
    expect(Object.values(sizes).every((s) => s.encrypted < 4000), JSON.stringify(sizes));
    return `shop_at ${sizes.access.raw} B (sent as is); shop_rt ${sizes.refresh.encrypted} B encrypted (raw ${sizes.refresh.raw}); shop_id ${sizes.id.encrypted} B encrypted (raw ${sizes.id.raw})`;
  });

  // Criterion 5 (phase 3): each backend, called directly inside Docker, refuses what is not a valid
  // access token for it with 401. The expired case is in check 11, which waits for one.
  await check('15', 'Each backend called directly refuses bad tokens with 401, accepts a valid one', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const claims = decodeJwt(alice.tokens.access_token);
    const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'forged' }).sign(privateKey);
    const lines = [];
    for (const [unit, port] of [['shell', 4001], ['catalog', 4002], ['cart', 4003]]) {
      const me = (token) =>
        fetch(`http://${unit}-backend:${port}/me`, token ? { headers: { authorization: `Bearer ${token}` } } : {}).then((r) => r.status);
      const statuses = {
        none: await me(),
        otherKey: await me(forged),
        idToken: await me(alice.tokens.id_token),
        valid: await me(alice.tokens.access_token),
      };
      expect(statuses.none === 401 && statuses.otherKey === 401 && statuses.idToken === 401, `${unit}: ${JSON.stringify(statuses)}`);
      expect(statuses.valid === 200, `${unit}: valid token answered ${statuses.valid}`);
      lines.push(`${unit} ${JSON.stringify(statuses)}`);
    }
    const bobAtCatalog = await fetch('http://catalog-backend:4002/me', { headers: { authorization: `Bearer ${bob.tokens.access_token}` } }).then((r) => r.status);
    expect(bobAtCatalog === 401, `bob's token (no catalog-backend in aud) answered ${bobAtCatalog}`);
    return `${lines.join('; ')}; bob without catalog-backend in aud: ${bobAtCatalog}`;
  });

  // Criterion 13 (phase 5): the Keycloak adapter, from shop-shell's built server-common, passes the
  // same contract the unit tests check a fake IdP against (ADR 0004).
  await check('19', 'The Keycloak adapter passes the IdP adapter contract, and fails closed when unreachable', async () => {
    const { checkAdapterContract, checkUnavailableContract } = await import('./shell-common/auth/idp/contract.js');
    const { keycloakAdapter } = await import('./shell-common/auth/idp/keycloak.js');
    const { lazyIdp } = await import('./shell-common/auth/metadata.js');
    const settings = {
      issuer: PUBLIC_ISSUER,
      internalUrl: `${INTERNAL}/realms/shop`,
      clientId: 'catalog-backend',
      clientSecret: env('CATALOG_BACKEND_SECRET'),
    };
    expect(ended, 'needs check 12 (a logged-out session)');
    const decoded = (token) => ({ header: decodeProtectedHeader(token), claims: decodeJwt(token) });
    const { sub, sid } = decodeJwt(alice.tokens.access_token);
    const checked = await checkAdapterContract(keycloakAdapter(lazyIdp(settings)), {
      user: { sub, sid, username: 'alice', unit: 'catalog', roles: ['catalog-editor', 'catalog-viewer'] },
      userWithoutRole: { sub: decodeJwt(bob.tokens.access_token).sub },
      endedSession: { sub: ended.sub, sid: ended.sid },
      unknownSub: '00000000-0000-0000-0000-000000000000',
      tokens: {
        access: decoded(alice.tokens.access_token),
        id: decoded(alice.tokens.id_token),
        refresh: decoded(alice.tokens.refresh_token),
      },
      service: {
        claims: decodeJwt(await serviceToken(server, 'cart-backend', env('CART_BACKEND_SECRET'))),
        client: 'catalog-backend',
        role: 'catalog-api:read-products',
      },
    });
    const unreachable = keycloakAdapter(lazyIdp({ ...settings, internalUrl: 'http://127.0.0.1:9/realms/shop' }, 500), 500);
    checked.push(await checkUnavailableContract(unreachable, sub, sid));
    return checked.join('; ');
  });

  // Criterion 10 (phase 4): backend to backend with API roles (ADR 0005).
  await check('17', 'Catalog\'s /service/products: only a service granted catalog-api:read-products', async () => {
    const products = 'http://catalog-backend:4002/service/products?ids=mug';
    const call = (token) =>
      fetch(products, token ? { headers: { authorization: `Bearer ${token}`, 'x-shop-user-sub': decodeJwt(alice.tokens.access_token).sub } } : {}).then((r) => r.status);
    const cart = await serviceToken(server, 'cart-backend', env('CART_BACKEND_SECRET'));
    const ops = await serviceToken(server, 'shop-ops', env('SHOP_OPS_SECRET'));
    const statuses = { cart: await call(cart), ops: await call(ops), user: await call(alice.tokens.access_token), none: await call() };
    expect(statuses.cart === 200 && statuses.user === 401 && statuses.none === 401, JSON.stringify(statuses));
    expect(statuses.ops === 401 || statuses.ops === 403, `shop-ops answered ${statuses.ops}`);
    return `Cart's service token ${statuses.cart}; shop-ops (no grant, no catalog-backend in aud) ${statuses.ops}; a user's token ${statuses.user}; none ${statuses.none}`;
  });

  // Criterion 11 (phase 4): the operator token on the router's unit health.
  await check('18', '/health/units* and /version/units* need the ops role; the router\'s own health is public', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const get = (path, token) =>
      context.request.get(`https://shop.test${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}).then((r) => r.status());
    const ops = await serviceToken(server, 'shop-ops', env('SHOP_OPS_SECRET'));
    const cart = await serviceToken(server, 'cart-backend', env('CART_BACKEND_SECRET'));
    const statuses = {
      none: await get('/health/units'),
      cart: await get('/health/units', cart),
      user: await get('/health/units', alice.tokens.access_token),
      ops: await get('/health/units', ops),
      opsVersions: await get('/version/units/catalog', ops),
      live: await get('/health/live'),
      version: await get('/version'),
    };
    await context.close();
    expect(statuses.none === 401 && statuses.cart === 401 && statuses.user === 401, JSON.stringify(statuses));
    expect(statuses.ops === 200 && statuses.opsVersions === 200, JSON.stringify(statuses));
    expect(statuses.live === 200 && statuses.version === 200, JSON.stringify(statuses));
    return JSON.stringify(statuses);
  });

  await check('14a', 'https://shop.test:8443/admin/ is refused through nginx', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const response = await context.request.get('https://shop.test:8443/admin/', { maxRedirects: 0 });
    await context.close();
    expect(response.status() === 404, `status ${response.status()}`);
    return 'status 404';
  });

  if (args.has('--quick')) {
    record('11', null, 'Skipped (--quick): logout with an expired ID token');
  } else {
    await check('11', 'Logout with an expired id_token_hint (5+ min old): no confirmation, session ends', async () => {
      const session = await login(browser, shellFes, 'bob');
      const lifetime = decodeJwt(session.tokens.id_token).exp * 1000 - Date.now();
      console.log(`       waiting ${Math.ceil((lifetime + 15_000) / 1000)} s for the ID token to expire…`);
      await new Promise((resolve) => setTimeout(resolve, lifetime + 15_000));
      const url = client.buildEndSessionUrl(shellFes, { id_token_hint: session.tokens.id_token, post_logout_redirect_uri: LOGGED_OUT });
      const back = session.page
        .waitForRequest((request) => request.url().startsWith(LOGGED_OUT), { timeout: 15_000 })
        .then(() => true, () => false);
      await session.page.goto(url.href);
      const redirected = await back;
      const confirmation = !redirected && (await session.page.locator('#kc-logout').isVisible());
      expect(redirected && !confirmation, `at ${session.page.url()}, confirmation ${confirmation}: "${(await session.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160)}"`);
      await expectRefreshFails(session.tokens.refresh_token);
      await expectSessionGone(session.tokens.access_token);
      // Criterion 5: the now expired access token, at a backend called directly.
      const expired = await fetch('http://cart-backend:4003/me', { headers: { authorization: `Bearer ${session.tokens.access_token}` } }).then((r) => r.status);
      expect(expired === 401, `an expired access token at cart-backend answered ${expired}`);
      await session.context.close();
      return 'redirected straight back; the refresh token then failed; the sid is gone from the user\'s sessions; the expired access token is a 401 at cart-backend';
    });
  }

  await alice.context.close();
  await bob.context.close();
  await browser.close();

  // What a backend's /me sees right after logout: the token's sid is no longer a live session.
  async function expectSessionGone(accessToken) {
    const { sub, sid } = decodeJwt(accessToken);
    const adminToken = await serviceToken(server, 'catalog-backend', env('CATALOG_BACKEND_SECRET'), 'kc-admin-api');
    const sessions = await admin(adminToken, `/users/${sub}/sessions`);
    expect(!sessions.some((x) => x.id === sid), 'the session is still live after logout');
  }

  async function expectRefreshFails(refreshToken) {
    try {
      await client.refreshTokenGrant(shellFes, refreshToken);
    } catch {
      return;
    }
    throw new Error('refresh still works after logout');
  }
}

await main();
const failed = results.filter((r) => r.ok === false);
console.log(`\n${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
