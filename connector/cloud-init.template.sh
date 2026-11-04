#!/bin/bash
# Bikas WhatsApp connector: Oracle Cloud "Initialization script". Contains a secret key: do not send it to anyone.
exec >> /var/log/bikas-install.log 2>&1
set -u
echo "=== bikas cloud-init $(date -u +%FT%TZ) ==="
umask 077
cat > /etc/bikas-connector.env <<'BIKAS_ENV'
CRM_URL=__CRM_URL__
CONNECTOR_TOKEN=__CONNECTOR_TOKEN__
KEEP_BUSY=1
BIKAS_ENV
chmod 600 /etc/bikas-connector.env
umask 022
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsSL -o /root/bikas-install.sh https://raw.githubusercontent.com/sildar010386-cloud/ai-commerce-os/claude/practical-mendel-vjtsd5/connector/install.sh; then ok=1; break; fi
  echo "waiting for network ($i)"; sleep 10
done
[ "$ok" = 1 ] || { echo "could not download install.sh"; exit 1; }
bash /root/bikas-install.sh
echo "=== bikas cloud-init finished ==="
