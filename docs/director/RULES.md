# Правила директора: передача дел и маршрутизация моделей

Перенесено из CLAUDE.md 2026-11-12 без изменений.

- **Handoff 2026-11-12: start with `docs/director/HANDOFF.md` top section «Состояние на 12.11», then `docs/analytics/ANALYSIS_THREADS_2026-11-11.md`.** Work only on branch `claude/practical-mendel-vjtsd5` (GitHub Actions publish from it). Owner rule 2026-11-11: every statement backed by a number; propose the analysis and its criteria first, get approval, run it through Sonnet helpers, answer in tables; never suggest that the owner films himself. Queue 11–17.11 is approved and running on the 22.10 / 02.11 rules; next package from 18.11. Pending owner decisions (NOT approved yet): personal-brand Threads profile, reply-magnet reach posts with selling in comments, price in comments, AI series test for Reels/TikTok and Hugging Face PRO — see HANDOFF. Threads posts are reworded 20–30 % (never verbatim copies, owner 02.11) until the owner changes the rules. Avatar reels: pipeline in `tools/video/avatar/pipeline/`, poses in private `bikas-music/avatar/`, voice preset `owner2`. TikTok caption goes to the bot right after the draft.
- **Модели (владелец, 2026-10-22):** Opus — дирижёр и проверяющий; тексты — `bikas-writer` (Sonnet), тяжёлое чтение — `bikas-researcher` (Sonnet), механика публикаций и сбор данных — `bikas-publisher` (Haiku). Всё от помощников проверяется по `docs/director/QA_CHECKLIST.md` до отправки владельцу. Порядок: `docs/director/MODEL_ROUTING.md`. Одна сессия — один день/задача.

## Как Арман поручает работу (владелец, 2026-11-12)
- Сотрудники и их папки — `docs/director/STAFF_RULES.md`; файлы ролей — `.claude/agents/` (aigerim, olzhas, dinara, erlan, daniyar, asel, nurlan).
- Поручать по имени (Agent, subagent_type = имя файла). Модель задана в файле роли: Арман, Асель и Нурлан — Opus 5.5, остальные — Sonnet 5.5; менять только с разрешения владельца.
- Перед каждым сохранением — `git diff --stat`: изменения только в папке сотрудника; защищённые папки (crm, connector, tools, office, spybot, .claude, CLAUDE.md…) не тронуты.
- Старые помощники `bikas-writer`, `bikas-researcher`, `bikas-publisher` остаются до проверки новых на реальной задаче, потом убираются в архив по решению владельца.
