#!/bin/bash
# (Re)starts the game in this checkout. The server's post-receive hook runs it after every
# push (git config deploy.postCommand "PORT=3100 ./deploy/restart.sh"), and a crontab
# @reboot line runs it when the server boots.
#
# Game state lives in data/ (untracked), so restarts keep players, scores and the host key.
# The mystery is checked BEFORE the old server is stopped: a broken case fails the deploy
# and leaves the running game alone.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-3100}
PIDFILE=data/server.pid
LOG=data/server.log
mkdir -p data

node verify.js > /dev/null || { node verify.js | grep -E '❌|⚠️' || true; echo "restart.sh: mystery check failed, old server left running"; exit 1; }

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2> /dev/null; then
    kill "$(cat "$PIDFILE")"
    for _ in $(seq 50); do kill -0 "$(cat "$PIDFILE")" 2> /dev/null || break; sleep 0.1; done
fi
# The supervisor stops its node child on the way out; wait until the port is really free.
for _ in $(seq 50); do ss -ltnH "sport = :$PORT" | grep -q . || break; sleep 0.1; done

# setsid + nohup: the game must outlive the push's SSH session. supervise.sh restarts the
# server if it ever crashes; the pid file holds the supervisor, so stopping it stops both.
PORT=$PORT setsid nohup ./deploy/supervise.sh >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 50); do
    curl -fs "http://127.0.0.1:$PORT/api/state" > /dev/null 2>&1 && break
    sleep 0.1
done
if ! curl -fs "http://127.0.0.1:$PORT/api/state" > /dev/null 2>&1; then
    echo "restart.sh: server did not come up on port $PORT, last log lines:"
    tail -n 20 "$LOG"
    exit 1
fi
echo "restart.sh: running (pid $(cat "$PIDFILE"), port $PORT)"
grep -E 'Players join at|TV / big screen|Host controls' "$LOG" | tail -n 3
