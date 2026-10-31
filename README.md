# shop-mfe-platform

Runs the whole shop on one machine with Docker: nginx in front of `shop-router`, then every unit's
FES and mock backend. It holds no application code; each unit keeps its own repository. Requirements
and decisions are in [arun-mfe-platform](https://github.com/arun9483/arun-mfe-platform).

```
Browser → nginx (HTTPS, cache) → shop-router → FES → mock backend
```

Only nginx is published. Each backend has its own network, so only its own FES can reach it.

## Run

Check out `shop-router`, `shop-shell`, `shop-catalog` and `shop-cart` next to this repository, and
copy each unit's `.env.example` files to `.env`.

```sh
cp docker/.env.example docker/.env
docker/build.sh                                  # HTTPS certificate and every image
docker compose -f docker/compose.yaml up -d
sudo sh -c 'echo "127.0.0.1 shop.test" >> /etc/hosts'
open https://shop.test
```

`build.sh` uses `mkcert` when it is installed, for a certificate your browser trusts. Otherwise it
makes a self-signed one, which the browser warns about.

## Change the domain

Change `PUBLIC_ORIGIN` in `docker/.env`, then run `docker/build.sh` again, because source maps are
tied to that URL. Update `/etc/hosts` to match and restart nginx. Nothing else names the domain.

## Swap an MFE

Set `MFE_CATALOG_URL` or `MFE_CART_URL`, recreate `shop-router` and restart nginx:

```sh
MFE_CATALOG_URL=http://other-build:3002 docker compose -f docker/compose.yaml up -d shop-router
docker compose -f docker/compose.yaml restart nginx
```

## Check

Run the end-to-end tests from `shop-shell` through the running stack:

```sh
E2E_BASE_URL=https://shop.test pnpm test:e2e
```

Tests that need a server's own port or start their own servers are left out; run `pnpm test:e2e`
without `E2E_BASE_URL` for those. Docker data appears in New Relic under the apps without the
`staging` suffix, on hosts that start with `docker-`.
