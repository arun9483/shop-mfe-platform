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
mkdir -p certs
if ! openssl x509 -in certs/cert.pem -noout -checkhost "$host" 2>/dev/null | grep -q 'does match'; then
  if command -v mkcert >/dev/null; then
    mkcert -cert-file certs/cert.pem -key-file certs/key.pem "$host" localhost
  else
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout certs/key.pem -out certs/cert.pem \
      -subj "/CN=$host" -addext "subjectAltName=DNS:$host,DNS:localhost"
  fi
fi

for repo in shop-router shop-shell shop-catalog shop-cart; do
  "$repos/$repo/deploy/build.sh"
done
