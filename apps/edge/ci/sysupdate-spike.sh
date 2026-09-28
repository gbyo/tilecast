#!/usr/bin/env bash
# The M10 systemd-sysupdate spike (docs/tilecast-edge-m10-sysupdate-evaluation.md).
#
# Runs inside a throwaway Debian container as root, for example:
#
#   docker run --rm -i debian:trixie-slim bash -s < apps/edge/ci/sysupdate-spike.sh
#
# It installs systemd-sysupdate and measures the properties that the
# evaluation records: the Tilecast archive format, a local tar source into
# /opt/tilecast-edge/<version>, the current link, the verification of a local
# source, an interrupted installation, retention and a return to an earlier
# version. It is evidence for a decision, not part of any product path.
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
if ! apt-get install -y -qq --no-install-recommends systemd-container xz-utils zstd tar >/dev/null 2>&1; then
  apt-get install -y -qq --no-install-recommends systemd xz-utils zstd tar >/dev/null 2>&1
fi
SU=/usr/lib/systemd/systemd-sysupdate
if [ ! -x "$SU" ]; then
  echo "RESULT: no systemd-sysupdate on $(. /etc/os-release; echo "$PRETTY_NAME"), systemd $(dpkg-query -W -f='${Version}' systemd)"
  exit 0
fi
echo "## $(. /etc/os-release; echo "$PRETTY_NAME"): $($SU --version | head -1)"
mkdir -p /srv/updates /opt/tilecast-edge /etc/sysupdate.d

release() { # version compressor extension
  local dir
  dir=$(mktemp -d)
  mkdir -p "$dir/bin" "$dir/share"
  echo "tilecastd $1" >"$dir/bin/tilecastd"
  chmod 0755 "$dir/bin/tilecastd"
  head -c 60000000 /dev/urandom >"$dir/share/blob"
  tar --sort=name -C "$dir" -cf - . | $2 >"/srv/updates/tilecast-edge_$1.$3"
  rm -rf "$dir"
}

transfer() { # extension
  # systemd 251 to 255 read *.conf; systemd 257 reads *.transfer.
  local name=50-tilecast-edge.transfer
  [ "$($SU --version | awk 'NR==1{print $2}')" -lt 257 ] && name=50-tilecast-edge.conf
  cat >"/etc/sysupdate.d/$name" <<EOF
[Transfer]
Verify=yes
[Source]
Type=tar
Path=/srv/updates
MatchPattern=tilecast-edge_@v.$1
[Target]
Type=directory
Path=/opt/tilecast-edge
MatchPattern=@v
CurrentSymlink=/opt/tilecast-edge/current
InstancesMax=2
EOF
}

echo "## 1. the existing Tilecast archive format (tar.zst)"
release 0.1.0 "zstd -q -T1" tar.zst
transfer tar.zst
$SU update 2>&1 | tail -3
rm -f /srv/updates/*

echo "## 2. a local tar source (tar.xz), Verify=yes"
transfer tar.xz
release 0.2.0 "xz -0 -T1" tar.xz
$SU update 2>&1 | tail -2
echo "current -> $(readlink /opt/tilecast-edge/current)"
stat -c 'installed tree mode %a owner %U' /opt/tilecast-edge/0.2.0

echo "## 3. SIGKILL while the next version unpacks"
release 0.3.0 "xz -0 -T1" tar.xz
$SU update >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 500); do ls -a /opt/tilecast-edge | grep -q '^\.#' && break; sleep 0.01; done
kill -9 "$pid"
wait "$pid" 2>/dev/null
echo "after the kill: $(ls -A /opt/tilecast-edge | tr '\n' ' ') current -> $(readlink /opt/tilecast-edge/current)"
$SU update 2>&1 | tail -1
echo "after a new run: $(ls -A /opt/tilecast-edge | tr '\n' ' ') current -> $(readlink /opt/tilecast-edge/current)"

echo "## 4. retention (InstancesMax=2) when the next version installs"
release 0.4.0 "xz -0 -T1" tar.xz
$SU update 2>&1 | tail -1
echo "installed: $(ls /opt/tilecast-edge | tr '\n' ' ')"

echo "## 5. a return to the previous version"
$SU update 0.3.0 2>&1 | tail -1
echo "current -> $(readlink /opt/tilecast-edge/current)"
