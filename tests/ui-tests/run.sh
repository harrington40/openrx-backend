#!/usr/bin/env bash
#
# Run the Playwright UI tests. Configuration is via environment variables —
# see README.md. Any arguments are passed through to pytest (e.g. --headed).
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
    if [[ -x "$HERE/.venv/bin/python" ]]; then
        PYTHON="$HERE/.venv/bin/python"
    else
        PYTHON="python3"
    fi
fi

BASE_URL="${UI_BASE_URL:-http://localhost:5173}"
echo "[ui] python : $PYTHON"
echo "[ui] base   : $BASE_URL"
echo "[ui] token  : $([[ -n "${UI_TOKEN:-}" ]] && echo set || echo 'unset (will log in via API)')"
echo "[ui] domains: ${UI_DOMAINS:-<all>}"

exec "$PYTHON" -m pytest "$@"
