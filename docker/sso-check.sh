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

env_files=(--env-file .env)
for repo in shop-shell shop-catalog shop-cart; do
  env_files+=(--env-file "$repos/$repo/keycloak/.env")
done

run_check() {
  docker run --rm --network shop_edge --network shop_idp "${env_files[@]}" \
    -v "$PWD/sso-check:/src:ro" "$playwright_image" \
    sh -c 'mkdir -p /work && cp /src/package.json /src/pnpm-lock.yaml /src/check.mjs /work/ && cd /work &&
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

exit "$failed"
