#!/usr/bin/env bash
# Runs several tenants side by side on one machine (MVP-3 phase 3). Each tenant is its own Compose project
# (tenant-<id>) with its own settings file (tenants/<id>.env), certificate, networks, Keycloak and data;
# the images are the same for every tenant (docker/build.sh builds them once).
#
#   docker/tenant.sh up <id>            certificate, then the tenant's stack with single sign-on
#   docker/tenant.sh down <id>          stops and removes it (its Keycloak data is kept)
#   docker/tenant.sh deploy <id>        uploads every client's source maps for the tenant's origin and keys
#   docker/tenant.sh check <id> [...]   sso-check.sh against the tenant
#   docker/tenant.sh front-door up|down the shared front door on ports 80 and 443
#
# The default stack (docker/.env) publishes the same ports as the front door: stop it first.
# The shop repositories are expected next to this one, or at SHOP_REPOS_DIR.
set -euo pipefail

cd "$(dirname "$0")"
repos="${SHOP_REPOS_DIR:-../..}"
command="${1:?usage: tenant.sh up|down|deploy|check <id> | front-door up|down}"

# The front door's routing table, from every tenant's settings file: its two hosts to its nginx's port.
write_front_door() {
  local file
  for file in tenants/*.env; do
    [ -e "$file" ] || continue
    (
      set -a
      # shellcheck source=/dev/null
      . "./$file"
      printf 'upstream tenant_%s { server host.docker.internal:%s; }\n' "$TENANT_ID" "$TENANT_HTTPS_PORT" >&3
      printf '%s tenant_%s;\n%s tenant_%s;\n' "$PUBLIC_HOST" "$TENANT_ID" "$IDP_HOST" "$TENANT_ID" >&4
    ) 3>>"$tmp.upstreams" 4>>"$tmp.hosts"
  done
  awk -v uf="$tmp.upstreams" -v hf="$tmp.hosts" '
    /# TENANT_UPSTREAMS/ { while ((getline line < uf) > 0) print "    " line; next }
    /# TENANT_HOSTS/ { while ((getline line < hf) > 0) print "        " line; next }
    { print }' nginx/front-door.conf >nginx/front-door.generated.conf
}

if [ "$command" = front-door ]; then
  case "${2:?up or down}" in
    up)
      tmp="$(mktemp)"
      trap 'rm -f "$tmp" "$tmp.upstreams" "$tmp.hosts"' EXIT
      write_front_door
      docker compose -f compose.front-door.yaml up -d --wait --force-recreate
      ;;
    down) docker compose -f compose.front-door.yaml down ;;
    *) echo "front-door: up or down" >&2; exit 1 ;;
  esac
  exit 0
fi

id="${2:?tenant id, e.g. orga}"
settings="tenants/$id.env"
[ -f "$settings" ] || { echo "No $settings: copy tenants/$id.env.example and fill it in" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. "./$settings"
set +a
[ "${TENANT_ID:-}" = "$id" ] || { echo "$settings must set TENANT_ID=$id" >&2; exit 1; }

compose() {
  docker compose -p "tenant-$id" --env-file "$settings" \
    -f compose.yaml -f compose.sso.yaml -f compose.tenant.yaml "$@"
}

case "$command" in
  up)
    ./certs.sh "$PUBLIC_HOST" "$IDP_HOST" "$CERTS_DIR"
    compose up -d --wait
    ;;
  down)
    compose down
    ;;
  deploy)
    # Catalog's and Cart's errors are reported by the Shell's browser agent: every map goes to the
    # tenant's browser app.
    for repo in shop-shell shop-catalog shop-cart; do
      NEW_RELIC_BROWSER_APP_ID="$PUBLIC_NEW_RELIC_APPLICATION_ID" "$repos/$repo/deploy/upload-sourcemaps.sh"
    done
    ;;
  check)
    shift 2
    TENANT="$id" ./sso-check.sh "$@"
    ;;
  *)
    echo "usage: tenant.sh up|down|deploy|check <id> | front-door up|down" >&2
    exit 1
    ;;
esac
