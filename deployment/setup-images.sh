#!/bin/bash
# Rocky Linux / 1Panel: download images only; no Node, npm or source build.
set -eu
prefix=''; public_url=''; version='0.4.0'; output='/opt/lan-note-sync'; output_set=0; data_dir=''; prepare_only=0; upgrade=0; listen=127.0.0.1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image-prefix) prefix=$2; shift 2;;
    --public-url) public_url=$2; shift 2;;
    --version) version=$2; shift 2;;
    --out) output=$2; output_set=1; shift 2;;
    --data-dir) data_dir=$2; shift 2;;
    --prepare-only) prepare_only=1; shift;;
    --upgrade) upgrade=1; shift;;
    --expose-lan) listen=0.0.0.0; shift;;
    *) printf '%s\n' 'Unknown argument.' >&2; exit 1;;
  esac
done
[[ "$prefix" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || { printf '%s\n' 'Specify --image-prefix, for example ghcr.io/account/obsidian-lan-sync.' >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'Use a published fixed version, for example 0.4.0.' >&2; exit 1; }
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
if [ "$upgrade" -eq 1 ]; then
  [ -f "$output/.env" ] && [ -f "$output/compose.yaml" ] || fail '--upgrade requires an existing deployment containing .env and compose.yaml. Use the original deployment directory.'
fi
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
# Stage both files before changing an existing deployment. Only the known block
# mapping emitted by our installers is patched; custom YAML shapes need review.
compose_stage=''; env_stage=''
trap 'if [ -n "$compose_stage" ]; then rm -f "$compose_stage"; fi; if [ -n "$env_stage" ]; then rm -f "$env_stage"; fi' EXIT
compose_stage=$(mktemp "$output/.compose.upgrade-XXXXXXXX")
compose_source="$template"
if [ -f "$output/compose.yaml" ]; then compose_source="$output/compose.yaml"; fi
if ! awk -v BINMODE=3 '
  function unsupported() { bad=1; exit 1 }
  function finish_environment() {
    if (!entries) unsupported()
    if (!password) print "      SYNC_ADMIN_PASSWORD: ${SYNC_ADMIN_PASSWORD:-}" cr
    if (!secure) print "      SYNC_ADMIN_SECURE_COOKIE: ${SYNC_ADMIN_SECURE_COOKIE:-false}" cr
    in_environment=0
  }
  {
    line=$0; sub(/\r$/, "", line)
    if (NR==1 && $0 ~ /\r$/) cr="\r"
    if (line ~ /^[ ]*(#.*)?$/) { print; next }
    if (line ~ /\t/) unsupported()
    match(line, /[^ ]/); indent=RSTART-1
    if (in_environment && indent<=4) finish_environment()
    if (in_sync && indent<=2) in_sync=0
    if (in_services && indent==0) in_services=0
    if (line=="services:") { if (++services!=1) unsupported(); in_services=1 }
    else if (in_services && indent==2 && line ~ /^  sync:[ ]*(#.*)?$/) {
      if (++sync!=1) unsupported(); in_sync=1
    } else if (in_sync && indent==4 && line ~ /^    environment:/) {
      if (++environment!=1 || line !~ /^    environment:[ ]*(#.*)?$/) unsupported()
      in_environment=1
    } else if (in_environment) {
      if (indent!=6 || line !~ /^      [A-Za-z_][A-Za-z0-9_.-]*:[ ]*/) unsupported()
      if (line ~ /^      SYNC_ADMIN_PASSWORD:/ && ++password!=1) unsupported()
      if (line ~ /^      SYNC_ADMIN_SECURE_COOKIE:/ && ++secure!=1) unsupported()
      entries++
    }
    print
  }
  END {
    if (bad) exit 1
    if (in_environment) finish_environment()
    if (services!=1 || sync!=1 || environment!=1) exit 1
  }
' "$compose_source" > "$compose_stage"; then
  fail 'Unrecognized Compose sync.environment mapping. No deployment files were changed. Add SYNC_ADMIN_PASSWORD and SYNC_ADMIN_SECURE_COOKIE to the sync service environment manually, then retry with a supported block mapping.'
fi
if [ -n "$data_dir" ]; then
  grep -Fq 'COUCHDB_DATA_DIR' "$compose_stage" && grep -Fq 'GATEWAY_DATA_DIR' "$compose_stage" || fail 'Existing Compose file does not support data-disk mounts; preserve the old deployment and migrate deliberately.'
fi
env_stage=$(mktemp "$output/.env.upgrade-XXXXXXXX")
if [ ! -f "$output/.env" ]; then
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'SYNC_IMAGE=%s:%s\nCOUCHDB_IMAGE=%s-couchdb:%s\nCOUCHDB_USER=lan_sync_admin\nCOUCHDB_PASSWORD=%s\nSYNC_PUBLIC_URL=%s\nSYNC_LISTEN_ADDRESS=%s\n' "$prefix" "$version" "$prefix" "$version" "$password" "${public_url%/}" "$listen" > "$env_stage"
  if [ -n "$data_dir" ]; then
    printf 'COUCHDB_DATA_DIR=%s/couchdb\nGATEWAY_DATA_DIR=%s/gateway\nBIND_LABEL_SUFFIX=:Z\n' "$data_dir" "$data_dir" >> "$env_stage"
  fi
elif [ "$upgrade" -eq 1 ]; then
  [ "$(grep -c '^SYNC_IMAGE=' "$output/.env")" -eq 1 ] && [ "$(grep -c '^COUCHDB_IMAGE=' "$output/.env")" -eq 1 ] || fail 'Expected exactly one SYNC_IMAGE and COUCHDB_IMAGE in the existing .env; no deployment files were changed.'
  awk -v BINMODE=3 -v sync="$prefix:$version" -v couch="$prefix-couchdb:$version" '
    /^SYNC_IMAGE=/ { print "SYNC_IMAGE=" sync ($0 ~ /\r$/ ? "\r" : ""); next }
    /^COUCHDB_IMAGE=/ { print "COUCHDB_IMAGE=" couch ($0 ~ /\r$/ ? "\r" : ""); next }
    { print }
  ' "$output/.env" > "$env_stage"
  printf '%s\n' 'Upgrade selected: image references updated; existing credentials, address and storage settings preserved.'
else
  cp "$output/.env" "$env_stage"
  printf '%s\n' 'Existing .env preserved; supplied image/address options were not applied. Use --upgrade to update images.'
fi
admin_password=''
if ! grep -q '^SYNC_ADMIN_PASSWORD=.' "$env_stage"; then
  admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  # Remove an old empty field before appending the newly generated password.
  sed -i '/^SYNC_ADMIN_PASSWORD=/d' "$env_stage"
  printf 'SYNC_ADMIN_PASSWORD=%s\n' "$admin_password" >> "$env_stage"
fi
if [ ! -f "$output/.env" ] || ! cmp -s "$env_stage" "$output/.env"; then mv "$env_stage" "$output/.env"; fi
if [ ! -f "$output/compose.yaml" ] || ! cmp -s "$compose_stage" "$output/compose.yaml"; then mv "$compose_stage" "$output/compose.yaml"; fi
if [ -n "$data_dir" ]; then
  mkdir -p "$data_dir/couchdb" "$data_dir/gateway"
fi
cd "$output"
if [ "$prepare_only" -eq 1 ]; then
  printf 'Prepared %s\nImport compose.yaml and .env using 1Panel file-based Compose creation.\n' "$(pwd -P)"
  if [ -n "$admin_password" ]; then printf 'Administrator password (save it): %s\n' "$admin_password"; fi
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
printf '%s\n' 'Management page: open http://SERVER_IP:27123/admin/ in your browser.'
if [ -n "$admin_password" ]; then printf 'Administrator password (save it): %s\n' "$admin_password"; fi
if [ -n "$public_url" ]; then
  docker compose exec -T sync node dist/server/cli.cjs invite --url "$public_url"
else
  printf '%s\n' 'No device address was required for deployment.' 'When connecting a device, generate an invite using the server address that device can reach:' 'docker compose exec -T sync node dist/server/cli.cjs invite --url http://SERVER_IP:27123'
fi
