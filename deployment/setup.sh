#!/bin/bash
set -eu
package=$(cd "$(dirname "$0")/.." && pwd -P)
public_url='http://127.0.0.1:27123'; listen='127.0.0.1'; name='My Notes'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-url) public_url=$2; shift 2;;
    --expose-lan) listen='0.0.0.0'; shift;;
    --name) name=$2; shift 2;;
    *) printf '%s\n' 'Unknown argument.' >&2; exit 1;;
  esac
done
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Install and start Docker first.' >&2; exit 1; }
docker info >/dev/null
docker compose version >/dev/null
case "$public_url" in https://*|http://*) ;; *) printf '%s\n' 'Expected an HTTP(S) root address.' >&2; exit 1;; esac
case "$public_url" in *[!a-zA-Z0-9:/._-]*|*@*|*\?*|*\#*) printf '%s\n' 'Invalid public URL.' >&2; exit 1;; esac
cd "$package"
if [ ! -e .env ]; then
  umask 077
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'COUCHDB_USER=lan_sync_admin\nCOUCHDB_PASSWORD=%s\nSYNC_PUBLIC_URL=%s\nSYNC_LISTEN_ADDRESS=%s\n' "$password" "${public_url%/}" "$listen" > .env
else printf '%s\n' 'Existing deployment configuration preserved.'; fi
admin_password=''
if ! grep -q '^SYNC_ADMIN_PASSWORD=.' .env; then
  umask 077
  admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  admin_env=$(mktemp .env.admin-XXXXXXXX)
  sed '/^SYNC_ADMIN_PASSWORD=/d' .env > "$admin_env"
  printf 'SYNC_ADMIN_PASSWORD=%s\n' "$admin_password" >> "$admin_env"
  mv "$admin_env" .env
fi
docker compose up -d --build --wait --wait-timeout 180
printf '%s\n' 'Services are ready. Keep the Vault ID below for additional devices.'
printf 'Management page: %s/admin/\n' "${public_url%/}"
if [ -n "$admin_password" ]; then printf 'Administrator password (save it): %s\n' "$admin_password"; fi
docker compose exec -T sync node dist/server/cli.cjs invite --name "$name"
