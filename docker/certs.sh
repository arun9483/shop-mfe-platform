#!/usr/bin/env bash
# Makes the HTTPS certificate for one tenant: its shop host and its IdP host (F4: each on its own host),
# with mkcert when installed (trusted locally), otherwise self-signed. Keeps a certificate that already
# covers both hosts. Keys are never committed.
#
#   docker/certs.sh <shop-host> <idp-host> [dir]    dir defaults to docker/certs
set -euo pipefail

host="${1:?shop host, e.g. shop.test}"
idp_host="${2:?IdP host, e.g. idp.test}"
dir="${3:-$(dirname "$0")/certs}"

# Reads the names from the certificate text: macOS's LibreSSL has no -checkhost.
covers() { openssl x509 -in "$dir/cert.pem" -noout -text 2>/dev/null | grep -qE "DNS:$1(,|$)"; }
mkdir -p "$dir"
if covers "$host" && covers "$idp_host"; then
  exit 0
fi
if command -v mkcert >/dev/null; then
  mkcert -cert-file "$dir/cert.pem" -key-file "$dir/key.pem" "$host" "$idp_host" localhost
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout "$dir/key.pem" -out "$dir/cert.pem" \
    -subj "/CN=$host" -addext "subjectAltName=DNS:$host,DNS:$idp_host,DNS:localhost"
fi
