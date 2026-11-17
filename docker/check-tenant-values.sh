#!/usr/bin/env bash
# MVP-3 criterion 7: no tenant value in source. Searches every shop repository for the default tenant's
# hosts and realm (shop.test, idp.test, realms/shop) and fails on any use that is not documentation
# (Markdown, comments, .env.example, "e.g. …" in a message), tenant settings (tenants/*.env, gitignored) or a default (`${VAR:-…}`, `?? '…'`, `|| '…'`).
# The shop repositories are expected next to this one, or at SHOP_REPOS_DIR.
set -euo pipefail

repos="${SHOP_REPOS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
found="$(
  for repo in shop-mfe-platform shop-router shop-shell shop-catalog shop-cart; do
    grep -rnIE 'shop\.test|idp\.test|realms/shop' "$repos/$repo" \
      --exclude-dir={node_modules,dist,.git,test-results,playwright-report,certs,sourcemaps} \
      --exclude={pnpm-lock.yaml,'*.md','.env','*.env','.env.example','*.env.example',front-door.generated.conf,check-tenant-values.sh} || true
  done |
    # Comments: shell and YAML (#), JavaScript (//, /* … */, leading *).
    grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//|/\*|\*)' |
    # Examples in messages, then defaults: ${VAR:-value}, `?? 'value'`, `|| 'value'`.
    grep -vE 'e\.g\. (https://)?(shop|idp)\.test' |
    grep -vE ':-[^}]*(shop\.test|idp\.test|shop\})|\?\? .?(https://)?(shop|idp)\.test|\|\| .?(https://)?(shop|idp)\.test' || true
)"
if [ -n "$found" ]; then
  echo "$found"
  echo "FAIL  tenant values in source (criterion 7)"
  exit 1
fi
echo "PASS  no tenant value in source outside defaults and documentation (criterion 7)"
