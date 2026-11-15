#!/usr/bin/env bash
# Prepares the local stack from docker/.env: the HTTPS certificate for PUBLIC_ORIGIN and every image.
# The shop repositories are expected next to this one, or at SHOP_REPOS_DIR.
set -euo pipefail

cd "$(dirname "$0")"
set -a
# shellcheck source=/dev/null
. ./.env
set +a
repos="${SHOP_REPOS_DIR:-../..}"

host="${PUBLIC_ORIGIN#*://}"
host="${host%%[:/]*}"
# One certificate for the shop and, with login on, its IdP on its own host (F4).
./certs.sh "${PUBLIC_HOST:-$host}" "${IDP_HOST:-idp.test}" certs

for repo in shop-router shop-shell shop-catalog shop-cart; do
  "$repos/$repo/deploy/build.sh"
done
