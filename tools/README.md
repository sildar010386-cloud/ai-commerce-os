# tools/ — автоматизация органики

- Чей код: проект органики (публикации, статистика, видео, Telegram, Threads, TikTok, Instagram, референсы, синхронизация с CRM).
- Что делает: `publish/` публикует слоты из `content/queue/`, `stats/` собирает цифры, `video/` монтаж, `telegram/` бот `@bikas_content_bot`, `tiktok/`, `threads/`, `instagram/`, `crm/`, `refs/`, `music/`, `ai/`.
- Можно ли трогать: правки кода только по задаче; пути и имена файлов менять нельзя — их вызывают GitHub Actions, планировщики и `.claude/settings.json`.
- Кто запускает: GitHub Actions и сессии Claude; секреты берутся из переменных среды, в код не вписываются.
