# Bikas CRM (Cloudflare Worker + D1)

Своя CRM без claude.ai: вход по почте и паролю, заказы, контент-план, склад, прибыль, менеджеры. Работает на бесплатном тарифе Cloudflare (Worker + база D1). Страница открывается с телефона и с компьютера.

## Что нужно добавить в GitHub (один раз)

Репозиторий → Settings → Secrets and variables → Actions → New repository secret. Добавьте секреты:

| Секрет | Что это |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Токен Cloudflare: My Profile → API Tokens → Create Token → шаблон **Edit Cloudflare Workers** → Use template → «+ Add more»: **Account · D1 · Edit** → Account Resources: ваш аккаунт, Zone Resources: All zones → Continue to summary → Create Token. |
| `CLOUDFLARE_ACCOUNT_ID` | Номер аккаунта Cloudflare (Workers & Pages → справа «Account ID»). |
| `CRM_API_KEY` | Любая длинная случайная строка (30+ символов). Это ключ, которым публикации и воронка пишут в CRM. Никому не показывайте. |
| `CRM_ADMIN_EMAIL` | Ваша почта — по ней вы входите в CRM (например `you@gmail.com`). |
| `CRM_ADMIN_PASSWORD` | Ваш пароль для входа, **не короче 10 символов**. |
| `GH_DISPATCH_TOKEN` | Необязательно. Токен GitHub для кнопки «Опубликовать сейчас» прямо в CRM: Settings → Developer settings → Fine-grained tokens → доступ только к этому репозиторию, право **Actions: Read and write**. Без него кнопка открывает страницу GitHub, где нужно нажать «Run workflow». |

Один раз зайдите в Cloudflare → Workers & Pages и, если попросит, выберите имя поддомена workers.dev.

## Как развернуть

1. GitHub → Actions → **CRM deploy** → Run workflow.
2. Дождитесь зелёной галочки. В конце в журнале и на странице запуска будет адрес CRM.
3. Откройте адрес, войдите почтой и паролем из секретов `CRM_ADMIN_EMAIL` / `CRM_ADMIN_PASSWORD`.
4. Адрес CRM сохраняется сам (файл `crm/url.txt`), публикации и воронка начинают писать в CRM автоматически.

Повторный запуск безопасен: он обновит CRM, данные не трогает, второго админа не создаёт. Чтобы обновить CRM после изменений в коде, просто запустите деплой ещё раз.

## Как пользоваться

- **Меню → Менеджеры и доступы**: создать менеджера (имя, почта и пароль, которые вы ему придумали; передайте лично), отключить, сбросить пароль. Менеджер видит заказы, контент, остатки, номера WhatsApp и ссылку на оплату; прибыль, кассу, закупку и настройки не видит (закрыто на сервере).
- **Меню → Моя почта и пароль**: сменить свою почту и пароль.
- **Меню → Настройки**: номера WhatsApp, ссылка на оплату, шаблоны.
- **Меню → Склад**: добавьте товар (цену и остаток). Остаток уменьшается сам, когда заказ получает статус «Отправлен».
- **Контент**: статусы постов обновляются сами после каждой публикации; красный «ошибка» — публикация не прошла.
- Заявки из воронки Threads (комментарий «пар») появляются в «Заказах» сами, статус «Новый».
- После 10 неверных паролей подряд вход для этой почты закрывается на 15 минут.

## Для разработчика

- `src/worker.js` — API и раздача страницы; `public/` — страница (JS и CSS в файлах, инлайн-скриптов нет из-за CSP); `migrations/` — схема D1.
- Машинные эндпоинты (заголовок `X-Api-Key`): `POST /api/hooks/lead`, `/api/hooks/content-sync`, `/api/hooks/content-status`, `/api/hooks/bot-stats`, `/api/bootstrap`.
- Клиенты на Python: `tools/crm/client.py`, `tools/crm/sync_content.py`. Адрес — `CRM_URL` или `crm/url.txt`; без адреса или `CRM_API_KEY` они ничего не делают.
- Локальный запуск: `npm i wrangler@3.114.17`, `npx wrangler d1 migrations apply bikas-crm --local`, `npx wrangler dev --local --var CRM_API_KEY:test`.
