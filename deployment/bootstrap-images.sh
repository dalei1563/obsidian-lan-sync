#!/bin/bash
# Download the verified deployment templates for the versioned GHCR release.
set -eu
source_ref=d3f199caa616b06fe73257fff095be0c0a0aec2d
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
check_hash "$stage/compose.production.yaml" 1e82fef8aeb567328851175ee102a528b650fc24d6233bf99941b42407e60732
check_hash "$stage/deployment/setup-images.sh" 209745e4e1d6ea228cc7b7a281cc8eb7e23e92186b5246a9e2c7f814f14ffdd3
bash "$stage/deployment/setup-images.sh" --image-prefix ghcr.io/dalei1563/obsidian-lan-sync --version 0.4.0 --expose-lan "$@"
