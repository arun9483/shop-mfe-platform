#!/usr/bin/env bash
# Checks the shop's identity provider against the MVP-2 design, on a stack started with
# compose.sso.yaml. Signs in through Keycloak's own page with Playwright (Chromium) inside Docker.
#
#   docker/sso-check.sh           every check, about 7 minutes (one waits for an ID token to expire)
#   docker/sso-check.sh --quick   without that one
#   TENANT=orga docker/sso-check.sh   against a tenant started with docker/tenant.sh (MVP-3 phase 3)
#
# The shop repositories are expected next to this one, or at SHOP_REPOS_DIR.
set -euo pipefail

cd "$(dirname "$0")"
repos="${SHOP_REPOS_DIR:-../..}"
# The default tenant: docker/.env and Compose project shop. A tenant: its settings file and project.
if [ -n "${TENANT:-}" ]; then
  env_file="tenants/$TENANT.env"
  compose=(docker compose -p "tenant-$TENANT" --env-file "$env_file" -f compose.yaml -f compose.sso.yaml -f compose.tenant.yaml)
  project="tenant-$TENANT"
else
  env_file=.env
  compose=(docker compose -f compose.yaml -f compose.sso.yaml)
  project="${COMPOSE_PROJECT_NAME:-shop}"
fi
set -a
# shellcheck source=/dev/null
. "./$env_file"
set +a
realm="${OIDC_REALM:-shop}"
playwright_image=mcr.microsoft.com/playwright:v1.64.1-noble

# The units' secrets, then the tenant's settings, which replace them for a tenant.
env_files=()
for repo in shop-shell shop-catalog shop-cart; do
  env_files+=(--env-file "$repos/$repo/keycloak/.env")
done
env_files+=(--env-file "$env_file")

run_check() {
  # The public origins (edge), Keycloak (idp-admin) and each unit's own network, to call backends directly.
  docker run --rm --network "${project}_edge" --network "${project}_idp-admin" --network "${project}_shell" \
    --network "${project}_catalog" --network "${project}_cart" "${env_files[@]}" \
    -e OIDC_REALM="$realm" -e PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://shop.test}" \
    -v "$PWD/sso-check:/src:ro" "$playwright_image" \
    sh -c 'mkdir -p /work && cp /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/check.mjs /work/ &&
      cd /work &&
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
    docker exec "$project-$container-1" wget -q -T 2 -O /dev/null "$url" >/dev/null 2>&1
  else
    docker exec "$project-$container-1" node -e \
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
expect_reach yes shop-router "http://keycloak:8080/realms/$realm"
if [ "$isolation_failed" = 0 ]; then
  echo "PASS  16  Cart's and Catalog's backends reach each other (catalog-api, two-way); no other unit, the router or nginx reaches a backend"
else
  echo "FAIL  16  a backend is reachable where it should not be, or not where it should"
  failed=1
fi

exit "$failed"
