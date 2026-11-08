#!/bin/bash
# Download the verified deployment templates for the first GHCR release.
set -eu
source_ref=8fda990e68929687ff3bc4967cb6127154fe1628
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
check_hash "$stage/deployment/setup-images.sh" 612c926e0dc45c8d202d71f2b620d33596dc4a2963efc1e7d520627e78a60e07
bash "$stage/deployment/setup-images.sh" --image-prefix ghcr.io/dalei1563/obsidian-lan-sync --version 0.3.0 --expose-lan "$@"
