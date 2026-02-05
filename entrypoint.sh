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
  echo "[entrypoint] Starting cloudflared tunnel to localhost:${PORT} (metrics: 127.0.0.1:${TUNNEL_METRICS_PORT})"

  # 启动 cloudflared 并提取 URL 到文件
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[entrypoint] ERROR: cloudflared command not found. Cannot start tunnel."
  else
    # 确保 /tmp 目录存在 (兼容性)
    mkdir -p /tmp

    cloudflared tunnel \
      --url "http://127.0.0.1:${PORT}" \
      --metrics "127.0.0.1:${TUNNEL_METRICS_PORT}" \
      --no-autoupdate > /tmp/cloudflared.log 2>&1 &
    CLOUDFLARED_PID=$!
  fi

  # 在后台异步提取 URL
  (
    timeout=60
    while [ $timeout -gt 0 ]; do
      if [ -f /tmp/cloudflared.log ]; then
        # 增强正则：兼容不同大小写和更宽泛的字符集
        URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cloudflared.log | head -n 1)
        if [ -n "$URL" ]; then
          echo "$URL" > /tmp/cloudflared.url
          echo "[entrypoint] Captured quick tunnel URL: $URL"
          break
        fi
      fi
      sleep 2
      timeout=$((timeout - 2))
    done
    if [ ! -f /tmp/cloudflared.url ]; then
      echo "[entrypoint] Failed to capture tunnel URL after 60s. Check /tmp/cloudflared.log"
    fi
  ) &
fi

exit_code=0
while :; do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    wait "$NODE_PID" || exit_code=$?
    break
  fi

  if [ -n "${CLOUDFLARED_PID:-}" ] && ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    echo "[entrypoint] WARNING: cloudflared exited unexpectedly. Continuing without tunnel."
    CLOUDFLARED_PID=""
  fi

  sleep 1
done

cleanup
exit "$exit_code"

