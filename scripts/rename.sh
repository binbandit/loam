#!/usr/bin/env bash
# §9.4 scripted product rename. Usage:
#   scripts/rename.sh <NewName>            # dry run (default)
#   scripts/rename.sh <NewName> --apply    # perform the rename
#   scripts/rename.sh --self-test          # reversible fixture verification
set -euo pipefail
exec node "$(dirname "$0")/rename.mjs" "$@"
