#!/usr/bin/env bash
set -euo pipefail

expected_repository="${TILECAST_RUNNER_REPOSITORY:-gbyo/tilecast}"
expected_ref="${TILECAST_RUNNER_REF:-refs/heads/main}"
max_load_per_cpu="${TILECAST_RUNNER_MAX_LOAD_PER_CPU:-0.60}"
min_mem_mib="${TILECAST_RUNNER_MIN_MEM_MIB:-6144}"
min_disk_gib="${TILECAST_RUNNER_MIN_DISK_GIB:-30}"
poll_seconds="${TILECAST_RUNNER_POLL_SECONDS:-30}"
max_wait_seconds="${TILECAST_RUNNER_MAX_WAIT_SECONDS:-7200}"
disk_path="${TILECAST_RUNNER_DISK_PATH:-/opt}"

log() {
  printf '[tilecast-overflow] %s\n' "$*"
}

if [[ "${GITHUB_REPOSITORY:-}" != "$expected_repository" ]]; then
  log "refusing job for repository ${GITHUB_REPOSITORY:-unknown}"
  exit 1
fi

case "${GITHUB_EVENT_NAME:-}" in
  pull_request|pull_request_target)
    log "refusing ${GITHUB_EVENT_NAME} job on the home runner"
    exit 1
    ;;
esac

if [[ "${GITHUB_REF:-}" != "$expected_ref" ]]; then
  log "refusing ref ${GITHUB_REF:-unknown}; only $expected_ref is allowed"
  exit 1
fi

started_at="$(date +%s)"

while true; do
  cpu_count="$(nproc)"
  load_1m="$(awk '{print $1}' /proc/loadavg)"
  mem_available_mib="$(awk '/MemAvailable:/ {printf "%d", $2 / 1024}' /proc/meminfo)"
  disk_available_gib="$(df -Pk "$disk_path" | awk 'NR == 2 {printf "%d", $4 / 1024 / 1024}')"

  load_ok="$(awk -v load="$load_1m" -v cpus="$cpu_count" -v max="$max_load_per_cpu" 'BEGIN { print ((load / cpus) <= max) ? "yes" : "no" }')"

  if [[ "$load_ok" == "yes" ]] &&
     (( mem_available_mib >= min_mem_mib )) &&
     (( disk_available_gib >= min_disk_gib )); then
    log "host is idle enough: load=$load_1m/$cpu_count cpus, mem=${mem_available_mib}MiB, disk=${disk_available_gib}GiB"
    exit 0
  fi

  now="$(date +%s)"
  waited="$((now - started_at))"
  log "waiting for headroom: load=$load_1m/$cpu_count cpus (max/core $max_load_per_cpu), mem=${mem_available_mib}MiB (min $min_mem_mib), disk=${disk_available_gib}GiB (min $min_disk_gib)"

  if (( max_wait_seconds > 0 && waited >= max_wait_seconds )); then
    log "timed out after ${waited}s waiting for the host to become idle"
    exit 1
  fi

  sleep "$poll_seconds"
done
