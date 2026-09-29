#!/usr/bin/env bash
# First-time install on a fresh Ubuntu server. Run from the repository folder:
#   sudo bash scripts/install.sh
# Secrets are typed here, on the server, and saved only to .env (never into chat or git).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Устанавливаю Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if [ -f .env ]; then
  echo "==> .env уже есть — настройки не трогаю."
else
  echo "==> Настройки (ввод токенов не отображается на экране)"
  read -rsp "Токен бота от @BotFather: " BOT_TOKEN; echo
  read -rp  "api_id с my.telegram.org: " TELEGRAM_API_ID
  read -rsp "api_hash с my.telegram.org: " TELEGRAM_API_HASH; echo
  read -rp  "Ваш Telegram ID (Enter — пропустить, бот подскажет): " ALLOWED_USER_IDS
  umask 077
  cat > .env <<ENV
BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
ALLOWED_USER_IDS=${ALLOWED_USER_IDS}
POSTGRES_PASSWORD=$(openssl rand -hex 16)
ENV
  echo "==> Сохранено в .env (доступ только у root)"
fi

mkdir -p data/media data/state
echo "==> Запускаю..."
docker compose up -d --build
docker compose ps
echo
echo "Готово. Напишите боту /start в Telegram."
echo "Если бот ответит «Нет доступа» — выполните: sudo bash scripts/set_owner.sh <ваш ID>"
