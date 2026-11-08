#!/bin/bash
# Download the verified deployment templates for the versioned GHCR release.
set -eu
source_ref=804895e8bbc7a6417bde2e4814599ef503f14ac4
base="https://raw.githubusercontent.com/dalei1563/obsidian-lan-sync/$source_ref"
stage=$(mktemp -d "${TMPDIR:-/tmp}/lan-note-sync.XXXXXXXX")
cleanup() { rm -f "$stage/compose.production.yaml" "$stage/deployment/setup-images.sh"; rmdir "$stage/deployment" "$stage" 2>/dev/null || true; }
trap cleanup EXIT
mkdir "$stage/deployment"
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 "$base/compose.production.yaml" -o "$stage/compose.production.yaml"
curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 "$base/deployment/setup-images.sh" -o "$stage/deployment/setup-images.sh"
check_hash() {
  local file=$1 expected=$2 actual
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file" | awk '{print $1}');
  else actual=$(shasum -a 256 "$file" | awk '{print $1}'); fi
  [ "$actual" = "$expected" ] || { printf '%s\n' 'Deployment download integrity check failed.' >&2; exit 1; }
}
check_hash "$stage/compose.production.yaml" 42eea8caff3532898cb968e8d00fb3fc08b0f795946d91efecce74797f3a41f5
check_hash "$stage/deployment/setup-images.sh" 4c7b6bba8dd9e4f3eea434e78002be4ebb01f9b71a05c024a65d174a6ce7a543
bash "$stage/deployment/setup-images.sh" --image-prefix ghcr.io/dalei1563/obsidian-lan-sync --version 0.3.1 --expose-lan "$@"
