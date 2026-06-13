#!/usr/bin/env bash
# Serve nap cat locally. getUserMedia works on localhost without HTTPS.
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "nap cat -> http://localhost:${PORT}/"
echo "(camera needs localhost or HTTPS; 'd' key toggles the debug HUD)"
exec python3 -m http.server "$PORT"
