# AI Commerce OS — notes for development sessions

Owner-facing docs are in Russian; code, comments and commit messages are in English.

## Read first
- `docs/DECISIONS.md` — facts about the business and every owner decision. Source of truth; update it when a decision is made.
- `docs/PLAN_V2_KZ.md` — current plan and phase order (Kazakhstan, organic content, no managers).
- `docs/ARCHITECTURE_V1.md` — architecture principles: economics first, code before LLM, one PostgreSQL, Telegram as UI only, no business logic in the bot, LLM provider abstraction, kill switches.

## Current state
- **2026-10-06: daily packages paused** after week 1 gave 0 enquiries (`docs/ANALYSIS_WEEK1.md`). New approach focuses on scripts, video structure and 1080p+ footage; no paid ads, no price in videos. Start here: `docs/HANDOFF.md`. Content method (course + references + owner rules): skill `.claude/skills/bikas-content/SKILL.md` — read it before any script or content plan.
- **Content rule #1 (owner, 2026-10-01):** every video strictly follows the owner's brief (`docs/CONTENT_PLAYBOOK.md` §2: hook/intrigue → pain → solution → USP → CTA); only the format rotates (§1, §13). Threads threads and TikTok carousels always open with intrigue (first image, title, first words). The goal is enquiries and sales. Since 2026-10-09: 3 reels a day, exactly 1 of them selling (brief strictly, dedicated hook work: 5 variants + checklist) and 2 reach/useful/trust reels; the three formats differ from each other and from the previous day; personal-blog format ≈5 %, voice-over only; threads and carousels keep the intrigue open until the last slide (`docs/CONTENT_PLAYBOOK.md` §14).
- Content workflow (owner-approved, free): owner uploads raw clips as assets of a GitHub Release (tag `raw-NN`) in this repo; Claude downloads them in the session, reviews frames (contact sheets to save usage), edits 9:16 videos with ffmpeg, voices them with ElevenLabs (env `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`; host `api.elevenlabs.io` must be allowed), burns subtitles from the script, and sends finished MP4s to the owner in chat. Scripts: `docs/CONTENT_PLAYBOOK.md`.
- Voice: owner-approved ElevenLabs settings and stress rules in `content/voice/VOICE.md` (model `eleven_multilingual_v2`, never `eleven_v3`). Video builder: `tools/video/`. Video production order (owner-approved): `docs/CONTENT_PLAYBOOK.md` §12; background music from the private repo `sildar010386-cloud/bikas-music` (add_repo + clone), catalog and mix settings in `content/music/`.
- Instagram `@bikas.home` (business) is connected through the official Instagram API: token in env `IG_ACCESS_TOKEN`, host `graph.instagram.com` (`https://graph.instagram.com/v23.0/me?...`). Use it for profile, media and insights (`views, reach, saved, shares, ig_reels_avg_watch_time`). Do not look for Instagram in Make/Buffer; the Buffer channels `jansaya_sauda*` belong to an old account the owner does not want touched. - Threads `bikas.home` is connected too: token in env `THREADS_ACCESS_TOKEN`, host `graph.threads.net` (`https://graph.threads.net/v1.0/me?...`, post insights `views, likes, replies, reposts, quotes, shares`).
- TikTok (sandbox app «Bikas Home Publisher», Direct Post on; connected 2026-10-01, `tt.py me/videos/creator` work): keys in env `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`; helper `python3 tools/tiktok/tt.py` (allowed in `.claude/settings.json`); tokens in the private repo `bikas-music` `secrets/tiktok_token.json` (owner decision; add_repo access=push). Unaudited app: direct posts are private until TikTok review, so publish via inbox drafts (`tt.py draft`, owner pastes the caption and posts in the app; decision 2026-10-01); upload host `*.tiktokapis.com` must be allowed. Setup steps: `docs/SOCIAL_SETUP.md`. Instagram and Threads tokens expire ~60 days after 2026-09-30: remind the owner to regenerate them before ~2026-11-25.
- Daily cycle (owner decision 2026-10-01): at 22:00 Almaty stats + the next day's package (3 reels → Reels + Stories + TikTok, 5 Threads threads, 2 TikTok carousels from the 2 best-performing threads; 5 TikTok posts a day; decision 2026-10-09) go to the owner via Telegram bot `@bikas_content_bot` (`tools/telegram/tg.py`, env `TELEGRAM_BOT_TOKEN`, host `api.telegram.org`; owner chat id in `bikas-music/secrets/telegram.json`); after approval (text or voice) posts go out 09:00–22:00. Procedure: `docs/DAILY_ROUTINE.md`. Max 5 hashtags; TikTok carousels without a description.
- Publishing procedure and past mistakes to avoid: `docs/PUBLISHING.md` (read before any publish).
- Publishing: every post on every platform (Reels, TikTok, Threads posts/threads) only after the owner explicitly approves that exact post. Videos one at a time. Exception: an approved Reel is also posted to Instagram Stories right after it, without asking again. Drafts live in `content/threads/`, `content/reels/`.
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
