#!/bin/bash
# Rocky Linux / 1Panel: download images only; no Node, npm or source build.
set -eu
prefix=''; public_url=''; version='0.3.0'; output='./lan-note-sync-deploy'; prepare_only=0; listen=127.0.0.1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image-prefix) prefix=$2; shift 2;;
    --public-url) public_url=$2; shift 2;;
    --version) version=$2; shift 2;;
    --out) output=$2; shift 2;;
    --prepare-only) prepare_only=1; shift;;
    --expose-lan) listen=0.0.0.0; shift;;
    *) printf '%s\n' 'Unknown argument.' >&2; exit 1;;
  esac
done
[[ "$prefix" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || { printf '%s\n' 'Specify --image-prefix, for example ghcr.io/account/obsidian-lan-sync.' >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'Use a published fixed version, for example 0.3.0.' >&2; exit 1; }
if [ -n "$public_url" ]; then
  [[ "$public_url" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?/?$ ]] || { printf '%s\n' 'Expected a root HTTP(S) URL your devices can reach.' >&2; exit 1; }
fi
template="$(cd "$(dirname "$0")/.." && pwd -P)/compose.production.yaml"
[ -f "$template" ] || { printf '%s\n' 'Keep compose.production.yaml in the package root.' >&2; exit 1; }
umask 077
mkdir -p "$output"
if [ ! -f "$output/.env" ]; then
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'SYNC_IMAGE=%s:%s\nCOUCHDB_IMAGE=%s-couchdb:%s\nCOUCHDB_USER=lan_sync_admin\nCOUCHDB_PASSWORD=%s\nSYNC_PUBLIC_URL=%s\nSYNC_LISTEN_ADDRESS=%s\n' "$prefix" "$version" "$prefix" "$version" "$password" "${public_url%/}" "$listen" > "$output/.env"
else printf '%s\n' 'Existing .env preserved; supplied image/address options were not applied.'; fi
if [ ! -f "$output/compose.yaml" ]; then cp "$template" "$output/compose.yaml"; fi
cd "$output"
if [ "$prepare_only" -eq 1 ]; then
  printf 'Prepared %s\nImport compose.yaml and .env using 1Panel file-based Compose creation.\n' "$(pwd -P)"
  exit 0
fi
docker compose version >/dev/null
docker compose pull
docker compose up -d --wait --wait-timeout 180
printf 'Services are ready. Deployment directory: %s\n' "$(pwd -P)"
if [ -n "$public_url" ]; then
  docker compose exec -T sync node dist/server/cli.cjs invite --url "$public_url"
else
  printf '%s\n' 'No device address was required for deployment.' 'When connecting a device, generate an invite using the server address that device can reach:' 'docker compose exec -T sync node dist/server/cli.cjs invite --url http://SERVER_IP:27123'
fi
