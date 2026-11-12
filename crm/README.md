# crm/ — CRM Bikas (Cloudflare Worker + D1)

- Чей код: проект органики. Рабочий код — `crm/cf/` (Worker, миграции, тесты); `crm/bikas-crm.html` — страница CRM, `crm/url.txt` — адрес.
- Что делает: заказы и лиды, контент-план, склад, прибыль; принимает сообщения от WhatsApp-коннектора (`connector/`).
- Можно ли трогать: только по команде владельца; пути не менять — на них опираются деплой и `tools/crm/`.
- Кто деплоит: GitHub Actions «CRM deploy» из `crm/cf/` (файл `crm/cf/workflows/crm-deploy.yml`), запуск вручную.
- Подробности: `crm/cf/README.md`, документы — `docs/crm/`.
