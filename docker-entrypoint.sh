#!/bin/sh
# Make sure the data volume is writable, then run the server as the unprivileged "node" user.
set -e
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/terram.db}")"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups -- node dist/server/server/index.js
fi
exec node dist/server/server/index.js
