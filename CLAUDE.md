# AI Commerce OS — notes for development sessions

Owner-facing docs are in Russian; code, comments and commit messages are in English.

## Read first
- `docs/DECISIONS.md` — facts about the business and every owner decision. Source of truth; update it when a decision is made.
- `docs/PLAN_V2_KZ.md` — current plan and phase order (Kazakhstan, organic content, no managers).
- `docs/ARCHITECTURE_V1.md` — architecture principles: economics first, code before LLM, one PostgreSQL, Telegram as UI only, no business logic in the bot, LLM provider abstraction, kill switches.

## Current state
- Content workflow (owner-approved, free): owner uploads raw clips as assets of a GitHub Release (tag `raw-NN`) in this repo; Claude downloads them in the session, reviews frames (contact sheets to save usage), edits 9:16 videos with ffmpeg, voices them with ElevenLabs (env `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`; host `api.elevenlabs.io` must be allowed), burns subtitles from the script, and sends finished MP4s to the owner in chat. Scripts: `docs/CONTENT_PLAYBOOK.md`.
- Voice: owner-approved ElevenLabs settings and stress rules in `content/voice/VOICE.md` (model `eleven_multilingual_v2`, never `eleven_v3`). Video builder: `tools/video/`.
- Instagram `@bikas.home` (business) is connected through the official Instagram API: token in env `IG_ACCESS_TOKEN`, host `graph.instagram.com` (`https://graph.instagram.com/v23.0/me?...`). Use it for profile, media and insights (`views, reach, saved, shares, ig_reels_avg_watch_time`). Do not look for Instagram in Make/Buffer; the Buffer channels `jansaya_sauda*` belong to an old account the owner does not want touched. Setup and next platforms (Threads, TikTok): `docs/SOCIAL_SETUP.md`.
- Publishing: one video at a time, only after the owner approves it.
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
