#!/bin/bash
# Rocky Linux / 1Panel: download images only; no Node, npm or source build.
set -eu
prefix=''; public_url=''; version='0.3.1'; output='/opt/lan-note-sync'; output_set=0; data_dir=''; prepare_only=0; listen=127.0.0.1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image-prefix) prefix=$2; shift 2;;
    --public-url) public_url=$2; shift 2;;
    --version) version=$2; shift 2;;
    --out) output=$2; output_set=1; shift 2;;
    --data-dir) data_dir=$2; shift 2;;
    --prepare-only) prepare_only=1; shift;;
    --expose-lan) listen=0.0.0.0; shift;;
    *) printf '%s\n' 'Unknown argument.' >&2; exit 1;;
  esac
done
[[ "$prefix" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || { printf '%s\n' 'Specify --image-prefix, for example ghcr.io/account/obsidian-lan-sync.' >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'Use a published fixed version, for example 0.3.1.' >&2; exit 1; }
if [ -n "$public_url" ]; then
  [[ "$public_url" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?/?$ ]] || { printf '%s\n' 'Expected a root HTTP(S) URL your devices can reach.' >&2; exit 1; }
fi
template="$(cd "$(dirname "$0")/.." && pwd -P)/compose.production.yaml"
[ -f "$template" ] || { printf '%s\n' 'Keep compose.production.yaml in the package root.' >&2; exit 1; }
fail() { printf '%s\n' "$1" >&2; exit 1; }
if [ -z "$data_dir" ] && [ -f "$output/.env" ]; then
  saved_couch_path=$(sed -n 's/^COUCHDB_DATA_DIR=//p' "$output/.env")
  if [ -n "$saved_couch_path" ]; then
    case "$saved_couch_path" in */couchdb) data_dir=${saved_couch_path%/couchdb}; output_set=1;; *) fail 'Configured CouchDB data path is not an application couchdb subdirectory.';; esac
  fi
fi
if [ -n "$data_dir" ]; then
  case "$data_dir" in /*) ;; *) fail '--data-dir must be an absolute path inside your mounted data disk.';; esac
  case "$data_dir" in *[\'\"\$\`:\\\#]*|*$'\n'*|*$'\r'*) fail 'Unsupported characters in data path.';; esac
  data_dir=${data_dir%/}
  case "$data_dir" in ''|/|/data|/mnt|/media|/home|/root|/opt|/usr|/var|/etc|/bin|/sbin|/tmp|/dev|/proc|/sys) fail 'Use a dedicated application subdirectory, for example /data/lan-note-sync.';; esac
  case "/$data_dir/" in */../*|*/./*) fail 'Data path must not contain . or .. segments.';; esac
  [ ! -L "$data_dir" ] || fail 'Data directory must not be a symbolic link.'
  data_parent=$(dirname "$data_dir")
  [ -d "$data_parent" ] || fail 'The parent data-disk directory does not exist. Mount the data disk first.'
  real_parent=$(cd "$data_parent" && pwd -P)
  [ "$real_parent" = "$data_parent" ] || fail 'Data directory parent must not contain symbolic links.'
  data_dir="$real_parent/$(basename "$data_dir")"
  if [ "$output_set" -eq 0 ]; then output="$data_dir/deployment"; fi
  for child in couchdb gateway deployment; do [ ! -L "$data_dir/$child" ] || fail 'Application data subdirectories must not be symbolic links.'; done
  # Never accept pre-existing files as an implicit database migration.
  if [ ! -f "$output/.env" ]; then
    for child in couchdb gateway; do
      if [ -d "$data_dir/$child" ] && [ -n "$(ls -A "$data_dir/$child")" ]; then fail 'Data directories are not empty. Restore the original deployment configuration before continuing.'; fi
    done
  fi
fi
umask 077
mkdir -p "$output"
output=$(cd "$output" && pwd -P)
if [ -n "$data_dir" ] && [ -f "$output/.env" ]; then
  grep -Fqx "COUCHDB_DATA_DIR=$data_dir/couchdb" "$output/.env" && grep -Fqx "GATEWAY_DATA_DIR=$data_dir/gateway" "$output/.env" && grep -Fqx 'BIND_LABEL_SUFFIX=:Z' "$output/.env" || fail 'Existing deployment uses different storage. Automatic data migration is not supported; keep the original volumes and configuration.'
fi
if [ "$prepare_only" -eq 0 ]; then
  docker compose version >/dev/null
  # A second config folder must not re-create the existing project's containers.
  containers=$(docker ps -aq --filter label=com.docker.compose.project=lan-note-sync-couch)
  for container in $containers; do
    owner_dir=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
    [ "$owner_dir" = "$output" ] || fail "This Compose project already belongs to another deployment directory: $owner_dir. Use that original directory; storage changes require migration."
  done
fi
if [ ! -f "$output/.env" ]; then
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'SYNC_IMAGE=%s:%s\nCOUCHDB_IMAGE=%s-couchdb:%s\nCOUCHDB_USER=lan_sync_admin\nCOUCHDB_PASSWORD=%s\nSYNC_PUBLIC_URL=%s\nSYNC_LISTEN_ADDRESS=%s\n' "$prefix" "$version" "$prefix" "$version" "$password" "${public_url%/}" "$listen" > "$output/.env"
  if [ -n "$data_dir" ]; then
    printf 'COUCHDB_DATA_DIR=%s/couchdb\nGATEWAY_DATA_DIR=%s/gateway\nBIND_LABEL_SUFFIX=:Z\n' "$data_dir" "$data_dir" >> "$output/.env"
  fi
else printf '%s\n' 'Existing .env preserved; supplied image/address options were not applied.'; fi
if [ ! -f "$output/compose.yaml" ]; then cp "$template" "$output/compose.yaml"; fi
if [ -n "$data_dir" ]; then
  grep -Fq 'COUCHDB_DATA_DIR' "$output/compose.yaml" && grep -Fq 'GATEWAY_DATA_DIR' "$output/compose.yaml" || fail 'Existing Compose file does not support data-disk mounts; preserve the old deployment and migrate deliberately.'
  mkdir -p "$data_dir/couchdb" "$data_dir/gateway"
fi
cd "$output"
if [ "$prepare_only" -eq 1 ]; then
  printf 'Prepared %s\nImport compose.yaml and .env using 1Panel file-based Compose creation.\n' "$(pwd -P)"
  exit 0
fi
docker compose pull
if grep -q '^COUCHDB_DATA_DIR=' .env; then
  # Read only generated fields; never execute the .env file as a shell script.
  couch_path=$(sed -n 's/^COUCHDB_DATA_DIR=//p' .env)
  gateway_path=$(sed -n 's/^GATEWAY_DATA_DIR=//p' .env)
  couch_image=$(sed -n 's/^COUCHDB_IMAGE=//p' .env)
  sync_image=$(sed -n 's/^SYNC_IMAGE=//p' .env)
  [ -d "$couch_path" ] && [ -d "$gateway_path" ] && [ ! -L "$couch_path" ] && [ ! -L "$gateway_path" ] || fail 'Configured data-disk directories are unavailable. Check the disk mount before starting.'
  storage_paths=$(printf '%s\n%s\n' "$couch_path" "$gateway_path")
  if [ -f .bind-permissions-ready ]; then
    [ "$(cat .bind-permissions-ready)" = "$storage_paths" ] || fail 'Storage paths changed. Restore the original configuration; migration must be explicit.'
  else
    [ -z "$containers" ] || fail 'Stop the existing Compose project before initializing bind permissions. Preserve and migrate both original data stores first.'
    # Initialize only mount roots once. Re-labeling :Z through a helper while
    # services are running would invalidate their SELinux labels, so never do it
    # on a normal re-run. Runtime services remain nonroot; no recursive chown.
    docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges --entrypoint /bin/sh -v "$couch_path:/state:Z" "$couch_image" -c 'chown 5984:5984 /state && chmod 700 /state'
    docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges --entrypoint /bin/sh -v "$gateway_path:/state:Z" "$sync_image" -c 'chown 1000:1000 /state && chmod 700 /state'
    printf '%s\n' "$storage_paths" > .bind-permissions-ready
  fi
fi
docker compose up -d --wait --wait-timeout 180
printf 'Services are ready. Deployment directory: %s\n' "$(pwd -P)"
if [ -n "$public_url" ]; then
  docker compose exec -T sync node dist/server/cli.cjs invite --url "$public_url"
else
  printf '%s\n' 'No device address was required for deployment.' 'When connecting a device, generate an invite using the server address that device can reach:' 'docker compose exec -T sync node dist/server/cli.cjs invite --url http://SERVER_IP:27123'
fi
