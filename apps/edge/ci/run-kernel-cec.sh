#!/usr/bin/env bash
# The HDMI-CEC provider against the real kernel CEC framework (M9).
#
# vivid, the kernel's virtual video test driver, registers one CEC adapter
# for its HDMI input (the TV side) and one for its HDMI output (the player
# side) on one virtual CEC bus. cec-follower from v4l-utils emulates the TV;
# Tilecast's provider drives the output adapter through the CEC UAPI; cec-ctl
# reads the result independently as the reference.
#
# Run on a Linux host with sudo (the Rust workspace CI job), from apps/edge.
# If vivid cannot be loaded the script fails with that reason: the test is
# never skipped silently.
set -euo pipefail

kernel=$(uname -r)
sudo apt-get update -q >/dev/null
sudo apt-get install -y -q v4l-utils >/dev/null
if ! modinfo vivid >/dev/null 2>&1; then
  sudo apt-get install -y -q "linux-modules-extra-$kernel" >/dev/null 2>&1 || true
fi
if ! sudo modprobe vivid n_devs=1 num_inputs=1 input_types=0x03 num_outputs=1 output_types=0x01; then
  echo "::error title=Kernel CEC test not run::the vivid driver could not be loaded on kernel $kernel"
  echo "### Kernel CEC test NOT RUN: vivid could not be loaded on kernel $kernel" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi
trap 'sudo pkill cec-follower || true; sudo modprobe -r vivid || true' EXIT
sleep 1
tv="" player=""
for device in /dev/cec*; do
  info=$(sudo cec-ctl -d "$device" 2>/dev/null || true)
  case "$info" in
    *vivid-*-vid-cap*) tv=$device ;;
    *vivid-*-vid-out*) player=$device ;;
  esac
done
if [ -z "$tv" ] || [ -z "$player" ]; then
  echo "::error title=Kernel CEC test not run::vivid loaded without its HDMI CEC adapters (CONFIG_VIDEO_VIVID_CEC)"
  ls -l /dev/cec* || true
  exit 1
fi
echo "vivid TV adapter $tv, player adapter $player"
sudo chmod 0666 "$tv" "$player"
# On current kernels a vivid HDMI input is connected to the test pattern
# generator by default, and the output adapter has no physical address (as
# with an unplugged cable) until the input is connected to vivid's HDMI
# output. Menu item 2 is "Output HDMI 000-0". Older kernels connect them
# implicitly and have no such control.
for video in /dev/video*; do
  controls=$(sudo v4l2-ctl -d "$video" --list-ctrls 2>/dev/null || true)
  if [[ "$controls" == *hdmi_000_0_is_connected_to* ]]; then
    sudo v4l2-ctl -d "$video" --set-ctrl hdmi_000_0_is_connected_to=2
    echo "connected vivid HDMI input 000-0 ($video) to HDMI output 000-0"
  fi
done
has_address() { [[ "$(sudo cec-ctl -d "$player" 2>/dev/null)" =~ Physical\ Address\ +:\ [0-9a-e]\. ]]; }
for _ in $(seq 1 50); do
  if has_address; then break; fi
  sleep 0.1
done
if ! has_address; then
  echo "::error title=Kernel CEC test not run::the vivid HDMI output adapter never received a physical address"
  sudo cec-ctl -d "$player" || true
  exit 1
fi
# The TV side: logical address 0, answered by cec-follower.
cec-ctl -d "$tv" --tv >/dev/null
cec-follower -d "$tv" > /tmp/cec-follower.log 2>&1 &
sleep 1

number=${player#/dev/cec}
TILECAST_CEC_TEST_ADAPTER=$number cargo test --locked -p edge-platform --test kernel_cec -- --ignored --nocapture

# The reference reads the TV's power state on its own.
reference=$(cec-ctl -d "$player" --to 0 --give-device-power-status 2>&1)
echo "$reference"
if ! grep -Eq 'pwr-state: on( |$|\()' <<<"$reference"; then
  echo "::error title=Kernel CEC reference mismatch::cec-ctl does not read the TV as on after Tilecast turned it on"
  cat /tmp/cec-follower.log
  exit 1
fi
echo "kernel CEC: Tilecast and cec-ctl agree the TV is on"
echo "### Kernel CEC test passed on kernel $kernel (vivid + cec-follower, cec-ctl reference)" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
