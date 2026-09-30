#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runner_dir="${TILECAST_RUNNER_DIR:-/opt/tilecast-actions-runner}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "run this installer with sudo" >&2
  exit 1
fi

if [[ ! -x "$runner_dir/run.sh" || ! -f "$runner_dir/.runner" ]]; then
  cat >&2 <<EOF
A configured GitHub Actions runner was not found at:
  $runner_dir

Create the repository runner first with the label "tilecast-overflow", then rerun:
  sudo $repo_root/deploy/ci-runner/install.sh

See docs/ci-overflow.md.
EOF
  exit 1
fi

if ! id tilecast-ci >/dev/null 2>&1; then
  echo "tilecast-ci user does not exist; configure the runner under that account first" >&2
  exit 1
fi

install -d -o root -g root -m 0755 /usr/local/lib/tilecast-ci
install -o root -g root -m 0755 "$repo_root/deploy/ci-runner/pre-job.sh" /usr/local/lib/tilecast-ci/pre-job.sh
install -o root -g root -m 0644 "$repo_root/deploy/ci-runner/tilecast-actions-runner.service" /etc/systemd/system/tilecast-actions-runner.service

usermod -aG docker tilecast-ci
systemctl daemon-reload
systemctl enable --now tilecast-actions-runner.service

echo
systemctl --no-pager --full status tilecast-actions-runner.service || true
