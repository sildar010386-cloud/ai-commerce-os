#!/usr/bin/env bash
# Show the last bot logs:  sudo bash scripts/logs.sh
cd "$(dirname "$0")/.."
docker compose logs --tail=100 bot
