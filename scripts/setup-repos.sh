#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/repos"

clone_if_missing() {
  local name="$1"
  local url="$2"
  local destination="$ROOT/repos/$name"

  if [[ -d "$destination/.git" || -f "$destination/package.json" ]]; then
    printf 'Reference repository already present: %s\n' "$destination"
    return
  fi
  if [[ -e "$destination" ]]; then
    printf 'Refusing to clone over existing non-git path: %s\n' "$destination" >&2
    return 1
  fi
  git clone --depth 1 "$url" "$destination"
}

clone_if_missing effect https://github.com/Effect-TS/effect.git
clone_if_missing inbox-zero https://github.com/elie222/inbox-zero.git
