#!/usr/bin/env bash
# Allow a Telegram user to use the bot:  sudo bash scripts/set_owner.sh 123456789[,987654321]
set -euo pipefail
cd "$(dirname "$0")/.."
ids="${1:?Укажите Telegram ID: sudo bash scripts/set_owner.sh 123456789}"
if [[ ! "$ids" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "ID должен состоять из цифр (несколько — через запятую)"; exit 1
fi
if grep -q '^ALLOWED_USER_IDS=' .env; then
  sed -i "s/^ALLOWED_USER_IDS=.*/ALLOWED_USER_IDS=${ids}/" .env
else
  echo "ALLOWED_USER_IDS=${ids}" >> .env
fi
docker compose up -d bot
echo "Готово: доступ открыт для ${ids}. Напишите боту /start."
