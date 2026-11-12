#!/usr/bin/env bash
# Checks the shop's identity provider against the MVP-2 design, on a stack started with
# compose.sso.yaml. Signs in through Keycloak's own page with Playwright (Chromium) inside Docker.
#
#   docker/sso-check.sh           every check, about 7 minutes (one waits for an ID token to expire)
#   docker/sso-check.sh --quick   without that one
#
# The shop repositories are expected next to this one, or at SHOP_REPOS_DIR.
set -euo pipefail

cd "$(dirname "$0")"
repos="${SHOP_REPOS_DIR:-../..}"
set -a
# shellcheck source=/dev/null
. ./.env
set +a
compose=(docker compose -f compose.yaml -f compose.sso.yaml)
playwright_image=mcr.microsoft.com/playwright:v1.64.1-noble

# The IdP adapter contract (check 19) runs shop-shell's built server-common against Keycloak.
shell_common="$(cd "$repos/shop-shell/server-common" && pwd)/dist"
[ -f "$shell_common/auth/idp/contract.js" ] || { echo "Build shop-shell's server-common first (pnpm build)"; exit 1; }

env_files=(--env-file .env)
for repo in shop-shell shop-catalog shop-cart; do
  env_files+=(--env-file "$repos/$repo/keycloak/.env")
done

run_check() {
  # The public origins (edge), Keycloak (idp-admin) and each unit's own network, to call backends directly.
  docker run --rm --network shop_edge --network shop_idp-admin --network shop_shell \
    --network shop_catalog --network shop_cart "${env_files[@]}" \
    -v "$PWD/sso-check:/src:ro" -v "$shell_common:/shell-common:ro" "$playwright_image" \
    sh -c 'mkdir -p /work && cp /src/package.json /src/pnpm-lock.yaml /src/check.mjs /work/ &&
      cp -R /shell-common /work/shell-common && cd /work &&
      npx --yes pnpm@11.28.5 install --frozen-lockfile --reporter=silent && node check.mjs "$@"' \
    check "$@"
}

import_again() {
  "${compose[@]}" run --rm --no-deps "$@" >/dev/null 2>&1
}

failed=0

echo "Checks 1-7, 9-14a"
run_check "$@" || failed=1

echo
echo "Check 8: re-running the settings importer leaves every repository's clients, roles and grants"
before=$(run_check --roles)
import_again keycloak-config
import_again keycloak-grants
import_again keycloak-config
import_again keycloak-grants
# One repository applying only its own file, as when it changes alone.
import_again -e IMPORT_FILES_LOCATIONS=file:/config/shop-cart/shop-cart.yaml keycloak-config
after=$(run_check --roles)
if [ "$before" = "$after" ]; then
  echo "PASS  8   identical after two full re-runs and one single-file run ($(grep -c '"' <<<"$before") lines compared)"
else
  echo "FAIL  8   roles or grants changed:"
  diff <(echo "$before") <(echo "$after") || true
  failed=1
fi

echo
echo "Check 14b: Keycloak's admin console only on 127.0.0.1:${KEYCLOAK_DEBUG_PORT:-8081}"
port="${KEYCLOAK_DEBUG_PORT:-8081}"
local_status=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/admin/master/console/" || true)
lan_ip=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
if [ -n "$lan_ip" ]; then
  lan_status=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$lan_ip:$port/admin/" || true)
else
  lan_status=skipped
fi
if [ "$local_status" = 200 ] && [ "$lan_status" != 200 ] && [ "$lan_status" != 302 ]; then
  echo "PASS  14b localhost:$port answers $local_status; $lan_ip:$port answers ${lan_status:-nothing}"
else
  echo "FAIL  14b localhost:$port answers $local_status; ${lan_ip:-other address}:$port answers $lan_status"
  failed=1
fi

echo
echo "Check 16: networks keep each backend private (MVP-1's rule, with the overlay on)"
# 0 when the URL answers from inside the container, otherwise not.
reach() {
  local container=$1 url=$2
  if [ "$container" = nginx ]; then
    docker exec "shop-$container-1" wget -q -T 2 -O /dev/null "$url" >/dev/null 2>&1
  else
    docker exec "shop-$container-1" node -e \
      "fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(2))" \
      "$url" >/dev/null 2>&1
  fi
}
isolation_failed=0
expect_reach() {
  local want=$1 container=$2 url=$3 got=no
  reach "$container" "$url" && got=yes
  if [ "$want" != "$got" ]; then
    echo "      $container -> $url: reachable=$got, expected $want"
    isolation_failed=1
  fi
}
expect_reach yes cart-backend http://catalog-backend:4002/health/live # catalog-api: Catalog's grant
expect_reach no cart-backend http://shell-backend:4001/health/live
# A network is two-way: Catalog's backend can reach Cart's too. Cart's backend still refuses any call
# without a valid token for it (check 15); one-way would need a proxy, more than this POC needs.
expect_reach yes catalog-backend http://cart-backend:4003/health/live
expect_reach no catalog-fes http://cart-backend:4003/health/live
expect_reach no shell-fes http://catalog-backend:4002/health/live
expect_reach no shop-router http://catalog-backend:4002/health/live
expect_reach no nginx http://catalog-backend:4002/health/live
expect_reach yes shop-router http://keycloak:8080/realms/shop
if [ "$isolation_failed" = 0 ]; then
  echo "PASS  16  Cart's and Catalog's backends reach each other (catalog-api, two-way); no other unit, the router or nginx reaches a backend"
else
  echo "FAIL  16  a backend is reachable where it should not be, or not where it should"
  failed=1
fi

exit "$failed"
