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

# Manual startup fallback (only if S6-overlay didn't start)
# Note: In production, S6-overlay should handle all processes.
# This fallback is kept for environments where S6-overlay cannot run as PID 1.
if [ "$#" -gt 0 ]; then
  echo "[entrypoint] Starting command: $*"
  exec "$@"
fi

echo "[entrypoint] Starting Node.js application with restart supervision..."
# 堆内存上限可通过 MAX_HEAP 环境变量配置，默认 512MB
MAX_HEAP="${MAX_HEAP:-512}"
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${MAX_HEAP} --max-semi-space-size=16 --expose-gc"

OTEL_TRACES_SAMPLER="${OTEL_TRACES_SAMPLER:-parentbased_traceidratio}"
OTEL_TRACES_SAMPLER_ARG="${OTEL_TRACES_SAMPLER_ARG:-0.1}"
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE="${OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE:-delta}"
export OTEL_TRACES_SAMPLER OTEL_TRACES_SAMPLER_ARG OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE

# Restart loop: if Node.js crashes, wait and restart.
# This handles the case where a platform sidecar (e.g. env-injector) is PID 1
# and does not propagate child exits to trigger container restart.
MAX_RESTARTS="${MAX_RESTARTS:-5}"
RESTART_DELAY="${RESTART_DELAY:-5}"
restart_count=0

cleanup() {
  # Forward SIGTERM to the child process group for graceful shutdown
  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill -TERM -- -"$NODE_PID" 2>/dev/null || kill -TERM "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup INT TERM

while true; do
  set +e
  node src/bootstrap/start.js &
  NODE_PID=$!
  wait "$NODE_PID"
  exit_code=$?
  set -e

  # If killed by signal (SIGTERM=128+15, SIGINT=128+2), exit cleanly
  if [ "$exit_code" -ge 128 ]; then
    echo "[entrypoint] Node.js terminated by signal (exit=$exit_code), shutting down."
    exit 0
  fi

  # Clean exit (exit 0) — likely intentional shutdown
  if [ "$exit_code" -eq 0 ]; then
    echo "[entrypoint] Node.js exited cleanly."
    exit 0
  fi

  restart_count=$((restart_count + 1))
  if [ "$restart_count" -ge "$MAX_RESTARTS" ]; then
    echo "[entrypoint] Node.js crashed $restart_count times, giving up."
    exit "$exit_code"
  fi

  echo "[entrypoint] Node.js crashed (exit=$exit_code). Restarting in ${RESTART_DELAY}s... ($restart_count/$MAX_RESTARTS)"
  sleep "$RESTART_DELAY"
done
