#!/bin/bash
# Daily launch on macOS. Builds are not installed over a running copy.
# The host and the CLI must already be next to this script's binaries, or
# in upstream-wezterm/target/release (the Studio looks there itself).
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
studio="${BETHSTUDIO_WEB:-$root/bethstudio-web/bethstudio-web}"
if [[ ! -x "$studio" ]]; then
  echo "Beth Studio não está compilado: $studio" >&2
  echo "Compile com: cd bethstudio-web && go build -o bethstudio-web ." >&2
  exit 1
fi
exec "$studio" "$@"
