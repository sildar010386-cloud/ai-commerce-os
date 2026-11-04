#!/bin/bash
# Bikas WhatsApp connector: start-up script for the server (Google Cloud: "Automation -> Startup script";
# Oracle Cloud: "Initialization script"). Contains a secret key: do not send it to anyone.
# Safe to run on every boot: it rewrites the same config and the installer only checks that the services run.
exec >> /var/log/bikas-install.log 2>&1
set -u
echo "=== bikas startup $(date -u +%FT%TZ) ==="
umask 077
cat > /etc/bikas-connector.env <<'BIKAS_ENV'
CRM_URL=__CRM_URL__
CONNECTOR_TOKEN=__CONNECTOR_TOKEN__
KEEP_BUSY=0
BIKAS_ENV
chmod 600 /etc/bikas-connector.env
umask 022
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsSL -o /root/bikas-install.sh.new https://raw.githubusercontent.com/sildar010386-cloud/ai-commerce-os/claude/practical-mendel-vjtsd5/connector/install.sh; then
    mv -f /root/bikas-install.sh.new /root/bikas-install.sh; ok=1; break
  fi
  echo "waiting for network ($i)"; sleep 10
done
if [ "$ok" != 1 ] && [ ! -f /root/bikas-install.sh ]; then echo "could not download install.sh"; exit 1; fi
bash /root/bikas-install.sh
echo "=== bikas startup finished ==="
