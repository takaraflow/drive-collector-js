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

# Manual startup fallback (only if S6-overlay didn't start)
# Note: In production, S6-overlay should handle all processes.
# This fallback is kept for environments where S6-overlay cannot run as PID 1.
if [ "$#" -gt 0 ]; then
  echo "[entrypoint] Starting command: $*"
  exec "$@"
fi

echo "[entrypoint] Starting Node.js application (fallback)..."
# 堆内存上限可通过 MAX_HEAP 环境变量配置，默认 512MB
MAX_HEAP="${MAX_HEAP:-512}"
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${MAX_HEAP} --max-semi-space-size=16 --expose-gc"

OTEL_TRACES_SAMPLER="${OTEL_TRACES_SAMPLER:-parentbased_traceidratio}"
OTEL_TRACES_SAMPLER_ARG="${OTEL_TRACES_SAMPLER_ARG:-0.1}"
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="${OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE:-delta}"
export OTEL_TRACES_SAMPLER OTEL_TRACES_SAMPLER_ARG OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE

exec node src/bootstrap/start.js
