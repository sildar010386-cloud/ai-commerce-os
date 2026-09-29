# AI Commerce OS — notes for development sessions

Owner-facing docs are in Russian; code, comments and commit messages are in English.

## Read first
- `docs/DECISIONS.md` — facts about the business and every owner decision. Source of truth; update it when a decision is made.
- `docs/PLAN_V2_KZ.md` — current plan and phase order (Kazakhstan, organic content, no managers).
- `docs/ARCHITECTURE_V1.md` — architecture principles: economics first, code before LLM, one PostgreSQL, Telegram as UI only, no business logic in the bot, LLM provider abstraction, kill switches.

## Current state
- Content workflow (owner-approved, free): owner uploads raw clips as assets of a GitHub Release (tag `raw-NN`) in this repo; Claude downloads them in the session, reviews frames (contact sheets to save usage), edits 9:16 videos with ffmpeg, voices them with ElevenLabs (env `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`; host `api.elevenlabs.io` must be allowed), burns subtitles from the script, and sends finished MP4s to the owner in chat. Scripts: `docs/CONTENT_PLAYBOOK.md`.
- `app/` (Telegram intake bot for a VPS) is parked: the owner did not approve a paid server. Do not deploy or extend it without explicit approval.
- Never add paid services or servers without the owner's explicit approval (see DECISIONS.md).

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
