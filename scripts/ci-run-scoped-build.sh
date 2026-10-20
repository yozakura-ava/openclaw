#!/usr/bin/env bash

# Run one compiler/build segment inside the qualification resource envelope.
# Linux CI must provide a user systemd manager so MemoryMax and MemorySwapMax
# are kernel-enforced instead of approximated with a Node heap setting.
set -euo pipefail

if (( $# == 0 )); then
  echo "usage: scripts/ci-run-scoped-build.sh <command> [args...]" >&2
  exit 64
fi

export GOMAXPROCS=2
export GOMEMLIMIT=3GiB
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=4096"

if [[ "${RUNNER_OS:-Linux}" != "Linux" ]]; then
  exec "$@"
fi

command -v systemd-run >/dev/null 2>&1 || {
  echo "[ci-scope] systemd-run is required for the 2-CPU/6-GiB build envelope" >&2
  exit 75
}
command -v taskset >/dev/null 2>&1 || {
  echo "[ci-scope] taskset is required for the 2-CPU build envelope" >&2
  exit 75
}

affinity_line="$(taskset -pc "$$" 2>&1 | tail -n 1)"
allowed="${affinity_line##*: }"
first="${allowed%%,*}"
first="${first%%-*}"
if [[ ! "$first" =~ ^[0-9]+$ ]]; then
  echo "[ci-scope] could not determine the runner CPU affinity: $affinity_line" >&2
  exit 75
fi
last_cpu="$first"
if [[ "$allowed" == *,* ]]; then
  second="${allowed#*,}"
  second="${second%%,*}"
  second="${second%%-*}"
  [[ "$second" =~ ^[0-9]+$ ]] && last_cpu="$second"
elif [[ "$allowed" == *-* ]]; then
  last_cpu="$((first + 1))"
fi
cpu_list="$first,$last_cpu"

echo "[ci-scope] cpu=$cpu_list cpu_quota=200% memory_max=6G swap_max=0 command=$*"
exec systemd-run \
  --user \
  --scope \
  --collect \
  --quiet \
  --property=CPUQuota=200% \
  --property=MemoryMax=6G \
  --property=MemorySwapMax=0 \
  --property=OOMPolicy=kill \
  -- taskset --cpu-list "$cpu_list" "$@"
