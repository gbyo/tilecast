# Home CI overflow runner

Tilecast can use a self-hosted Linux runner for trusted heavy CI without consuming a GitHub-hosted Linux slot. The first workload moved to it is the scheduled Go race suite.

The runner label is `tilecast-overflow`. Pull request validation remains on GitHub-hosted runners.

## Security boundary

Do not use this runner for pull request jobs. This repository is public, and the runner has Docker access so the server test workflow can start its PostgreSQL service container. Membership in the Docker group is effectively host-level privilege.

The pre-job hook in `deploy/ci-runner/pre-job.sh` refuses:

- jobs for repositories other than `gbyo/tilecast`
- `pull_request` and `pull_request_target` events
- refs other than `refs/heads/main`

That is a guardrail, not a sandbox. If this runner is expanded to execute arbitrary PR code, move it into a disposable VM first.

## Configure the runner on bell

Create a dedicated account and directory:

```bash
sudo useradd --create-home --shell /bin/bash tilecast-ci
sudo mkdir -p /opt/tilecast-actions-runner
sudo chown tilecast-ci:tilecast-ci /opt/tilecast-actions-runner
```

In GitHub, open **Settings → Actions → Runners → New self-hosted runner**, choose Linux x64, and use the download commands GitHub gives you inside `/opt/tilecast-actions-runner`.

Configure it as the dedicated account with the short-lived registration token from GitHub:

```bash
cd /opt/tilecast-actions-runner

sudo -u tilecast-ci ./config.sh \
  --url https://github.com/gbyo/tilecast \
  --token '<registration-token>' \
  --name bell-overflow \
  --labels tilecast-overflow \
  --work _work \
  --unattended
```

Then install the Tilecast hook and systemd unit from a checkout of this repository:

```bash
cd /opt/tilecast
git switch main
git pull --ff-only origin main

sudo ./deploy/ci-runner/install.sh
```

The installer adds `tilecast-ci` to the `docker` group, installs the root-owned pre-job hook, and starts the runner service.

## Load gate

Before a job starts, the hook waits until all of these are true:

- one-minute load average per CPU is at most `0.60`
- at least 6 GiB of memory is available
- at least 30 GiB is free on `/opt`

It waits up to two hours by default. These values live in the systemd unit and can be overridden with a systemd drop-in.

For example:

```ini
[Service]
Environment=TILECAST_RUNNER_MAX_LOAD_PER_CPU=0.45
Environment=TILECAST_RUNNER_MIN_MEM_MIB=7168
Environment=TILECAST_RUNNER_MIN_DISK_GIB=35
```

Apply a drop-in with:

```bash
sudo systemctl edit tilecast-actions-runner
sudo systemctl daemon-reload
sudo systemctl restart tilecast-actions-runner
```

## Verify it

Check that GitHub shows `bell-overflow` online with the `tilecast-overflow` label, then manually run **Scheduled Go race validation** and leave the default runner selection on `tilecast-overflow`.

On the server:

```bash
journalctl -u tilecast-actions-runner -f
```

The job should remain in the runner setup step while `bell` is busy and start once the load, memory, and disk thresholds are satisfied.

If the home runner is unavailable, manually dispatch the same workflow with `ubuntu-latest` to use GitHub-hosted capacity instead.

## Next step: queue-aware spillover

This first stage deliberately offloads only a trusted scheduled workload. It reduces GitHub-hosted contention without changing required PR checks.

A later dispatcher can watch GitHub-hosted queue time and route additional trusted `main` jobs to `tilecast-overflow` when the hosted queue is saturated. GitHub does not dynamically retarget an already queued `ubuntu-latest` job, so that stage requires selecting the runner before the job is created rather than trying to steal a queued job afterward.
