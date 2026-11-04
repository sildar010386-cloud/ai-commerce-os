#!/bin/bash
# Bikas WhatsApp connector installer. Idempotent. Run as root on Ubuntu 22.04 / 24.04 (x86_64 or arm64).
# Needs /etc/bikas-connector.env with CRM_URL and CONNECTOR_TOKEN (written by the startup / cloud-init script).
# Opens no ports: the connector only makes outbound HTTPS calls to the CRM.
# Safe to run on every boot (Google Cloud "Startup script"): when everything is already installed it only makes sure the
# services are enabled and running (a few seconds). BIKAS_FORCE=1 forces the full install/update. Never touches the WhatsApp
# session (/var/lib/bikas-connector/auth).
set -euo pipefail

BRANCH="${BIKAS_BRANCH:-claude/practical-mendel-vjtsd5}"
REPO="${BIKAS_REPO:-https://github.com/sildar010386-cloud/ai-commerce-os.git}"
APP=/opt/bikas-connector
STATE=/var/lib/bikas-connector
NODE_VERSION=20.20.2
NODE_SHA_X64=df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d
NODE_SHA_ARM64=73093db209e4e9e09dd7d15a47aeaab1b74833830df03efa5f942a1122c5fa71
ENV_FILE=/etc/bikas-connector.env

log() { echo "[bikas-install $(date -u +%H:%M:%S)] $*"; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -s "$ENV_FILE" ] || { echo "$ENV_FILE is missing: it must contain CRM_URL and CONNECTOR_TOKEN" >&2; exit 1; }
chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
export DEBIAN_FRONTEND=noninteractive

# KEEP_BUSY=1 (Oracle Always Free only) runs the low-priority load worker; default 0.
apply_busy() {
  if grep -Eq '^KEEP_BUSY=1\s*$' "$ENV_FILE"; then
    systemctl enable bikas-busy.service >/dev/null 2>&1
    systemctl "$1" bikas-busy.service
  else
    systemctl disable --now bikas-busy.service >/dev/null 2>&1 || true
  fi
}

# --- 0. fast path: already installed ---
if [ "${BIKAS_FORCE:-0}" != 1 ] && [ -d "$APP/.git" ] && [ -f "$APP/connector/node_modules/.package-lock.json" ] &&
   [ -x /usr/local/bin/node ] && [ -f /etc/systemd/system/bikas-connector.service ]; then
  log "already installed: making sure the services run"
  systemctl daemon-reload
  systemctl enable bikas-connector.service bikas-connector-update.timer >/dev/null 2>&1 || true
  systemctl start bikas-connector.service      # no-op when running: the WhatsApp session is not interrupted
  apply_busy start
  systemctl start bikas-connector-update.timer || true
  log "done (fast path)"
  exit 0
fi

# --- 1. swap: 1 GB machines need it for npm and for history sync ---
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 2000000 ] && [ -z "$(swapon --show=NAME --noheadings)" ]; then
  log "RAM < 2 GB: creating 2 GB swap file"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=20' > /etc/sysctl.d/99-bikas-swap.conf; sysctl -q -p /etc/sysctl.d/99-bikas-swap.conf || true
fi

# --- 2. packages ---
log "installing packages"
apt-get -o DPkg::Lock::Timeout=300 update -q
apt-get -o DPkg::Lock::Timeout=300 install -y -q git ffmpeg curl ca-certificates xz-utils
# Some npm dependencies are referenced over ssh in lock files; force https.
git config --system --replace-all url."https://github.com/".insteadOf "ssh://git@github.com/"
git config --system --get-all url."https://github.com/".insteadOf | grep -qx 'git@github.com:' ||
  git config --system --add url."https://github.com/".insteadOf "git@github.com:"

# --- 3. Node.js (official tarball, pinned, checksum verified) ---
case "$(uname -m)" in
  x86_64)  NODE_ARCH=x64;   NODE_SHA=$NODE_SHA_X64 ;;
  aarch64) NODE_ARCH=arm64; NODE_SHA=$NODE_SHA_ARM64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
NODE_DIR="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  log "installing Node.js $NODE_VERSION ($NODE_ARCH)"
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  echo "$NODE_SHA  $tmp/node.tar.xz" | sha256sum -c - >/dev/null
  tar -xJf "$tmp/node.tar.xz" -C /opt
  rm -rf "$tmp"
fi
for b in node npm npx; do ln -sf "$NODE_DIR/bin/$b" "/usr/local/bin/$b"; done

# --- 4. service user and directories ---
if ! id bikas >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin bikas
fi
mkdir -p "$STATE/home" "$APP"
chown -R bikas:bikas "$STATE" "$APP"
chmod 700 "$STATE"
as_bikas() { runuser -u bikas -- env HOME="$STATE/home" PATH="/usr/local/bin:/usr/bin:/bin" "$@"; }

# --- 5. code: public HTTPS clone, only connector/ ---
if [ -d "$APP/.git" ]; then
  log "updating code"
  as_bikas git -C "$APP" fetch --depth 1 origin "$BRANCH"
  as_bikas git -C "$APP" reset --hard FETCH_HEAD
else
  log "cloning code"
  as_bikas git clone --depth 1 --filter=blob:none --sparse --branch "$BRANCH" "$REPO" "$APP"
  as_bikas git -C "$APP" sparse-checkout set connector
fi
log "installing dependencies"
( cd "$APP/connector" && as_bikas npm ci --omit=dev --no-audit --no-fund )

# --- 6. systemd ---
cat > /etc/systemd/system/bikas-connector.service <<'UNIT'
[Unit]
Description=Bikas WhatsApp connector (linked device)
After=network-online.target
Wants=network-online.target

[Service]
User=bikas
Group=bikas
WorkingDirectory=/opt/bikas-connector/connector
EnvironmentFile=/etc/bikas-connector.env
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=400
StateDirectory=bikas-connector
StateDirectoryMode=0700
ExecStart=/usr/local/bin/node src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/bikas-busy.service <<'UNIT'
[Unit]
Description=Bikas low-priority CPU load (keeps an Always Free VM from being reclaimed as idle)
After=network.target

[Service]
User=bikas
Group=bikas
WorkingDirectory=/opt/bikas-connector/connector
EnvironmentFile=/etc/bikas-connector.env
ExecStart=/usr/local/bin/node src/busy.js
Nice=19
CPUSchedulingPolicy=idle
IOSchedulingClass=idle
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

cat > /usr/local/sbin/bikas-connector-update <<'SCRIPT'
#!/bin/bash
# Daily: fetch the branch; if connector/ changed, re-run the installer (which restarts the services).
set -euo pipefail
APP=/opt/bikas-connector
BRANCH="${BIKAS_BRANCH:-claude/practical-mendel-vjtsd5}"
as_bikas() { runuser -u bikas -- env HOME=/var/lib/bikas-connector/home PATH="/usr/local/bin:/usr/bin:/bin" "$@"; }
as_bikas git -C "$APP" fetch --depth 1 origin "$BRANCH"
old=$(as_bikas git -C "$APP" rev-parse HEAD:connector)
new=$(as_bikas git -C "$APP" rev-parse FETCH_HEAD:connector)
if [ "$old" = "$new" ]; then echo "connector/ unchanged"; exit 0; fi
as_bikas git -C "$APP" reset --hard FETCH_HEAD
tmp=$(mktemp); cp "$APP/connector/install.sh" "$tmp"   # do not run a script that git is about to rewrite
BIKAS_FORCE=1 bash "$tmp"; rm -f "$tmp"
SCRIPT
chmod 755 /usr/local/sbin/bikas-connector-update

cat > /etc/systemd/system/bikas-connector-update.service <<'UNIT'
[Unit]
Description=Update Bikas connector from git
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bikas-connector-update
UNIT
cat > /etc/systemd/system/bikas-connector-update.timer <<'UNIT'
[Unit]
Description=Daily update of the Bikas connector

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable bikas-connector.service >/dev/null 2>&1
systemctl restart bikas-connector.service
apply_busy restart
systemctl enable --now bikas-connector-update.timer >/dev/null 2>&1

log "done. Status: systemctl status bikas-connector ; logs: journalctl -u bikas-connector -f"
