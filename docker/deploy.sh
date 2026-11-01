#!/usr/bin/env bash
# Replaces all the pods of the given services with their current images at once, e.g.
# `docker/deploy.sh catalog-fes`. Old and new pods never run together, so a new entry.js can never ask
# an old pod for a chunk it does not have. The unit is unavailable for a moment; its Shell fallback shows.
set -euo pipefail

cd "$(dirname "$0")"
docker compose stop "$@"
docker compose up -d --wait "$@"
