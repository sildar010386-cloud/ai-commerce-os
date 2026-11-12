# AI Commerce OS — notes for development sessions

Owner-facing docs are in Russian; code, comments and commit messages are in English.

**Owner rule (2026-10-11, repeated many times): the owner does not read English. Every message to the owner — chat replies, short progress notes between tool calls, final summaries, bot messages — is in Russian only. Never switch to English in anything the owner sees.**

## Owner rules (always)
- Russian only: see the bold owner rule above (2026-10-11).
- Never start work without the owner's command: first say briefly what you want and what you need from him, wait for «начинай» — this covers every creation (trial videos, images, variants), even a step discussed earlier; production goes to Sonnet helpers, Opus only assigns and checks (owner 2026-10-31, repeated); Chrome tasks go to the chat, not the bot.
- Owner rule 2026-11-11: every statement backed by a number; propose the analysis and its criteria first, get approval, run it through Sonnet helpers, answer in tables; never suggest that the owner films himself.
- Publishing: every post on every platform (Reels, TikTok, Threads posts/threads) only after the owner explicitly approves that exact post. Videos one at a time. Exception: an approved Reel is also posted to Instagram Stories right after it, without asking again. Drafts live in `content/threads/`, `content/reels/`.
- `app/` (Telegram intake bot for a VPS) is parked: the owner did not approve a paid server. Do not deploy or extend it without explicit approval.
- Never add paid services or servers without the owner's explicit approval (see docs/director/DECISIONS.md).

## Map — where things live
Full map with staff and code folders: `MAP.md`.
- **director** → `docs/director/` (start with `docs/director/HANDOFF.md` top section «Состояние на 12.11», then `docs/director/DECISIONS.md`); rules: `docs/director/RULES.md`.
- **content** → `docs/content/RULES.md` + skill `.claude/skills/bikas-content/SKILL.md`.
- **video** → `docs/video/RULES.md`.
- **analytics** → `docs/analytics/`.
- **CRM** → `docs/crm/` and code `crm/`, `connector/`.
- **setup and tokens** → `docs/setup/ACCESS.md` (and `docs/setup/SETUP_GUIDE.md`, `docs/setup/SOCIAL_SETUP.md`).
- **ads** → the separate private repo, see the bullet below.
- **office 3D page** → `office/`.
- **Таргет (с 2026-11-12) ведётся из этого чата:** знания и правила рекламы — в отдельном закрытом репозитории `sildar010386-cloud/bikas-target` (читать его `CLAUDE.md` и `notes/HANDOFF.md`; подключать `add_repo` с access=push, клонировать в `/home/user/bikas-target`). Всё по рекламе сохранять только туда, органику — сюда; клиентские данные в этот публичный репозиторий не класть. Отдельный чат bikas-target больше не продолжаем.

## Read first
- `docs/director/DECISIONS.md` — facts about the business and every owner decision. Source of truth; update it when a decision is made.
- `docs/director/HANDOFF.md` — current handoff (top section «Состояние на 12.11»); the 2026-11-12 handoff rule and model routing are in `docs/director/RULES.md`.
- `docs/director/PLAN_V2_KZ.md` — current plan and phase order (Kazakhstan, organic content, no managers).
- `docs/director/ARCHITECTURE_V1.md` — architecture principles: economics first, code before LLM, one PostgreSQL, Telegram as UI only, no business logic in the bot, LLM provider abstraction, kill switches.

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
