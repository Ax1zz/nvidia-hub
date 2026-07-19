#!/usr/bin/env bash
# NVIDIA Hub launcher: start server (if not running) and open the UI.
cd "$(dirname "$0")"
PORT="${PORT:-8400}"
URL="http://127.0.0.1:${PORT}"

if ! curl -s -m 2 -o /dev/null "$URL/api/settings"; then
    nohup venv/bin/python -m app.main >> data/server.log 2>&1 &
    echo $! > data/server.pid
    for i in $(seq 1 30); do
        sleep 0.5
        curl -s -m 2 -o /dev/null "$URL/api/settings" && break
    done
fi

xdg-open "$URL" >/dev/null 2>&1 &
