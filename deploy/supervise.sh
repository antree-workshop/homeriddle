#!/bin/bash
# Keeps the game running: if node ever exits, start it again. restart.sh launches this
# detached; stopping this script (SIGTERM) stops the game for good.
#
# Restarting is safe mid-party: the server reloads players and scores from data/state.json.
cd "$(dirname "$0")/.."

child=
trap '[ -n "$child" ] && kill "$child" 2> /dev/null; exit 0' TERM INT

while true; do
    started=$(date +%s)
    node server.js &
    child=$!
    wait "$child"
    code=$?
    # A crash right after starting (bad config, port taken) would otherwise spin; back off.
    delay=2
    [ $(($(date +%s) - started)) -lt 10 ] && delay=10
    echo "supervise.sh: $(date '+%Y-%m-%d %H:%M:%S') server exited with code $code, restarting in ${delay}s"
    sleep "$delay" &
    wait $!
done
