# AI Commerce OS — notes for development sessions

Owner-facing docs are in Russian; code, comments and commit messages are in English.

## Read first
- `docs/DECISIONS.md` — facts about the business and every owner decision. Source of truth; update it when a decision is made.
- `docs/PLAN_V2_KZ.md` — current plan and phase order (Kazakhstan, organic content, no managers).
- `docs/ARCHITECTURE_V1.md` — architecture principles: economics first, code before LLM, one PostgreSQL, Telegram as UI only, no business logic in the bot, LLM provider abstraction, kill switches.

## Current state
- Phase 1a: Telegram intake bot (`app/`) — owner sends raw clips, they are stored under `MEDIA_DIR/<PRODUCT>/<date>/` and recorded in `clips`.
- Next: Phase 1b — automatic editing (ffmpeg) from the clip library by scripts in `docs/CONTENT_PLAYBOOK.md`, approval in Telegram.

## Stack and conventions
- Python 3.11+, aiogram 3, SQLAlchemy 2 async (asyncpg in prod), Docker Compose on one VPS in Kazakhstan (personal data localization).
- Local Telegram Bot API server (files up to 2 GB); long polling, no public ports.
- Tables are created by `init_db` (create_all). Switch to Alembic before the first schema change on data that must be kept.
- Secrets only in `.env` on the server (written by `scripts/install.sh`). Never ask the owner to paste secrets or account passwords into chat.
- Deploy: owner runs `scripts/update.sh` on the server (git pull + compose rebuild) from branch `claude/ai-ecommerce-automation-3n1lgz`.

## Tests
```
pip install -e ".[dev]"
pytest                      # SQLite
TEST_DATABASE_URL=postgresql+asyncpg://user:pass@localhost/db pytest   # PostgreSQL
```
