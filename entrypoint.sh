#!/bin/sh
set -eu

# s6-overlay must run as PID 1. Some platforms wrap the entrypoint (env injection, tini, etc.),
# which makes /init fail with: "s6-overlay-suexec: fatal: can only run as pid 1".
# Prefer s6-overlay when possible, otherwise fall back to a simple supervisor.

if [ "${S6_OVERLAY_ENABLED:-true}" = "true" ] && [ "$$" -eq 1 ] && [ -x /init ]; then
  exec /init
fi

APP_DIR="${APP_DIR:-/app}"
cd "$APP_DIR"

cleanup() {
  if [ -n "${CLOUDFLARED_PID:-}" ] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    kill -TERM "$CLOUDFLARED_PID" 2>/dev/null || true
  fi

  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM

if [ "$#" -gt 0 ]; then
  echo "[entrypoint] Starting command: $*"
  "$@" &
else
  echo "[entrypoint] Starting Node.js application..."
  node index.js &
fi
NODE_PID=$!

if [ "${TUNNEL_ENABLED:-}" = "true" ]; then
  PORT="${PORT:-7860}"
  TUNNEL_METRICS_PORT="${TUNNEL_METRICS_PORT:-2000}"
  echo "[entrypoint] Starting cloudflared tunnel to localhost:${PORT} (metrics: ${TUNNEL_METRICS_PORT})"

  # 启动 cloudflared 并提取 URL 到文件，同时保留日志输出
  cloudflared tunnel \
    --url "http://localhost:${PORT}" \
    --metrics "localhost:${TUNNEL_METRICS_PORT}" \
    --no-autoupdate 2>&1 | tee /dev/stderr | while read -r line; do
    URL=$(echo "$line" | grep -o 'https://[-0-9a-z]*\.trycloudflare\.com')
    if [ -n "$URL" ]; then
      echo "$URL" > /tmp/cloudflared.url
      echo "[entrypoint] Captured quick tunnel URL: $URL"
    fi
  done &
  CLOUDFLARED_PID=$!
fi

exit_code=0
while :; do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    wait "$NODE_PID" || exit_code=$?
    break
  fi

  if [ -n "${CLOUDFLARED_PID:-}" ] && ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    wait "$CLOUDFLARED_PID" || true
    echo "[entrypoint] cloudflared exited unexpectedly; shutting down"
    exit_code=100
    break
  fi

  sleep 1
done

cleanup
exit "$exit_code"

