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
copy each repository's `.env.example` files to `.env`.

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
tied to that URL. Update `/etc/hosts` to match. Nothing else names the domain.

## Swap an MFE

Set `MFE_CATALOG_URL` or `MFE_CART_URL` and recreate `shop-router`:

```sh
MFE_CATALOG_URL=http://other-build:3002 docker compose -f docker/compose.yaml up -d shop-router
```

## Scale

Every unit runs one pod by default. Set `ROUTER_PODS`, `SHELL_PODS`, `CATALOG_PODS` or `CART_PODS` in
`docker/.env`, where a unit's number covers its FES and its mock backend, then run
`docker compose -f docker/compose.yaml up -d --wait`.

- No unit holds session state, so no request needs to return to the same pod.
- nginx spreads requests across the router pods, and the router opens a new connection per request, so
  each one can reach any pod of a unit.
- A stopped server finishes its requests in flight, for up to 8 s, then exits.
- Docker's health checks use `/health/live`, never `/health/ready`: a backend that is down must not take
  its unit's files and `problem+json` errors away with it.
- nginx is the one piece that stays a single container. Production uses a managed CDN or load balancer.

## Deploy a unit

```sh
docker/deploy.sh catalog-fes
```

This replaces all of a service's pods at once, so old and new pods never run together: a new `entry.js`
can never ask an old pod for a chunk it does not have. The unit is unavailable for a few seconds, and
its Shell fallback shows.

## Check

Check every unit from the terminal, through the public origin:

```sh
export PUBLIC_ORIGIN=https://shop.test
curl -k "$PUBLIC_ORIGIN/health/units"
curl -k "$PUBLIC_ORIGIN/version/units"
curl -kfsS "$PUBLIC_ORIGIN/health/units/catalog"    # fails on a 503
curl -kfsS "$PUBLIC_ORIGIN/version/units/catalog"
```

`-k` accepts the self-signed certificate; drop it with `mkcert`. Backends stay private: a backend that
is down shows in its FES's readiness. To check one directly, run curl on its network:

```sh
docker run --rm --network shop_catalog curlimages/curl -fsS http://catalog-backend:4002/health/ready
```

Run the end-to-end tests from `shop-shell` through the running stack:

```sh
E2E_BASE_URL=https://shop.test pnpm test:e2e
```

Tests that need a server's own port or start their own servers are left out; run `pnpm test:e2e`
without `E2E_BASE_URL` for those. Docker data appears in New Relic under the apps without the
`staging` suffix, on hosts that start with `docker-`.
