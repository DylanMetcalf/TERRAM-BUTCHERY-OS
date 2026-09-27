#!/usr/bin/env bash
# Starts a throwaway production server on :8092 with sample data, for visual QA.
set -e
Q=${QA_DIR:-/tmp/terram-qa}
[ -f "$Q/pid" ] && kill "$(cat "$Q/pid")" 2>/dev/null || true
rm -rf "$Q"; mkdir -p "$Q"
DATABASE_PATH=$Q/t.db PORT=8092 TERRAM_DISABLE_AI=1 NODE_ENV=production INSECURE_COOKIES=1 node dist/server/server/index.js > "$Q/server.log" 2>&1 &
echo $! > "$Q/pid"
sleep 2
J="-s -H content-type:application/json -H x-terram:1 -b $Q/c -c $Q/c"
curl $J -X POST localhost:8092/api/auth/setup -d '{"name":"Dylan Metcalf","email":"dylan@terram.test","password":"butchery123"}' >/dev/null
curl $J -X POST localhost:8092/api/admin/sample-data -d '{"action":"load"}' >/dev/null
echo "QA server ready"
