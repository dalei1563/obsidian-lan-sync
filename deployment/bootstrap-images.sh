#!/bin/bash
# Download the verified deployment templates for the first GHCR release.
set -eu
source_ref=39d3f8c94ad98e9abba9636af532d21756844bdf
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
check_hash "$stage/compose.production.yaml" b794da6368992a2655c62e11daa0217536f6a2e35f3559aa1564aa9ca8a41b07
check_hash "$stage/deployment/setup-images.sh" 0ba5ab8b301209d111385567e2251a435ab908e9f70d97c9aa9a0fba31787ee5
bash "$stage/deployment/setup-images.sh" --image-prefix ghcr.io/dalei1563/obsidian-lan-sync --version 0.3.0 --out /opt/lan-note-sync "$@"
