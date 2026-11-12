# spybot/ — Telegram-приёмник бота-разведчика @Ildar_Food_bot

- Чей код: копия `worker/spy-bot` из закрытого репозитория `bikas-target` (реклама). Источник правды — там.
- Что делает: принимает сообщения бота в Telegram и передаёт их в bikas-target (repository_dispatch).
- Можно ли трогать: нет. Правки вносятся в bikas-target, сюда переносится копия.
- Кто деплоит: Actions «Spy bot deploy» (`spybot/spybot-deploy.yml`, в том же аккаунте Cloudflare, что и CRM), запуск вручную.
- Секреты только в GitHub Secrets, в репозиторий не класть.
