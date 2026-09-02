#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp -ac &

exec node index.js
