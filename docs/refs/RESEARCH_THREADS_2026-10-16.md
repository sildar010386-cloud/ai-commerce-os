# Bikas Home: как усилить Claude для Threads, Reels и TikTok — исследование

Дата: 16.10.2026. Режим: только чтение (ничего не устанавливал, не регистрировался, не платил, не лайкал, не комментировал, на рекламу не нажимал).

## Важные оговорки (прочитать первыми)

1. **Дословные тексты.** Вы просили полные тексты постов и промтов «слово в слово». По правилам авторского права я не копирую чужие тексты целиком: даю точную структуру, смысл, короткие фрагменты, ссылку на оригинал и цифры. Открыть оригинал можно по ссылке. Для промтов из открытых MIT-репозиториев полный текст лежит в файлах самих репозиториев (ссылки ниже).
2. **Живые посты Threads** я читал в браузере, где Threads уже был открыт под чьим-то аккаунтом. Я только читал: ничего не нажимал и не писал. Порядок цифр под постом: лайки / ответы / репосты / отправки. Просмотры видны на странице поста.
3. **Не удалось или охвачено слабо:** t-bank (сайт запрещает чтение роботам), Reddit, X/Twitter и YouTube (поиск не дал прямых результатов, их содержание я не открывал), vc.ru и Habr охвачены частично. Сайт-«складчину» freeskladchina.org (торрент-подобные платные курсы) не открывал.
4. **Метки достоверности:** [РЕКЛАМА] = материал продаёт курс/чат/инструмент; [БЕЗ ДОКАЗАТЕЛЬСТВ] = цифры только со слов; [ПРОВЕРЕНО] = цифры я видел сам (GitHub API, страница поста).

---

## ЧАСТЬ 1. Скиллы для Claude (15)

Звёзды и даты проверены мной через GitHub API 16.10.2026, если не указано иное.

| # | Скилл / набор | Автор | Звёзды / установки | Что делает | Чем поможет Bikas Home | Бесплатно |
|---|---|---|---|---|---|---|
| 1 | [marketingskills](https://github.com/coreyhaines31/marketingskills) | Corey Haines | 55 040★, обновлён 15.10.2026 [ПРОВЕРЕНО] | Набор маркетинговых скиллов: copywriting, copy-editing, social, ad-creative, analytics, content-strategy, video, launch. Ставится `npx skills add coreyhaines31/marketingskills`. | Продающие тексты для карточек Kaspi/сайта, креативы рекламы, контент-стратегия. Но заточен под англ. SaaS, под Threads отдельного скилла нет. | Да, MIT |
| 2 | [social-media-skills (106 скиллов)](https://github.com/social-media-skills/skills) | Frank Heijdenrijk и команда WoopSocial | 160★, обновлён 15.10.2026, MIT [ПРОВЕРЕНО] | 106 markdown-скиллов: threads-post, threads-growth, hook-writer, carousel-writer, reels-script, tiktok-script, tiktok-photo-mode, content-calendar, analytics-and-reporting, social-selling-and-dm и др. Все читают «профиль бренда» и голос. Публикация идёт через WoopSocial (необязательно, без него дают текст для ручной вставки). | Самое близкое к нашей задаче: хуки, сценарии Reels/TikTok, ветки Threads, контент-план, аналитика. **Эти скиллы уже подключены в этой среде Cowork** (список social-media-skills:* виден в сессии). | Скиллы да; WoopSocial — отдельный сервис, цену не проверял |
| 3 | [threads-skills](https://github.com/sergebulaev/threads-skills) | sergebulaev (Creative Content Crafts) | 48★, релиз v1.0.11 от 15.07.2026, MIT [ПРОВЕРЕНО] | 8 скиллов только под Threads: Post Writer, Humanizer (убирает «ИИ-стиль»), Hook Extractor (13 формул хуков), Reply Drafter, Repurposer, Content Planner, Profile Optimizer, Audience Insights (через Apify). Корпус формул основан на выборке 318 постов (июль 2026), автор сам называет её небольшой. | Готовая «школа Threads» внутри Claude: хуки, ответы, недельный план. Правила голоса англоязычные (например, про тире), для русского часть надо адаптировать. | Да; Apify и Publora необязательны, у них свои тарифы |
| 4 | [threads-kit](https://github.com/DevGreenBox/threads-kit) | DevGreenBox | 0★, 3 коммита, обновлён 13.09.2026; лицензия не указана [ПРОВЕРЕНО] | Набор на русском: threads-post, threads-thread, threads-research, линтер (ищет «ИИ-признаки», канцелярит, приманки на вовлечение, превышение 500 символов), агенты-исследователь/монитор/аналитик. Сначала Claude задаёт ~10 вопросов о нише и делает профиль. Есть предохранители от бана (лимит ответов, паузы). | Единственный найденный русскоязычный набор целиком под Threads. Сырой и без звёзд: смотреть код и тестировать осторожно, автоответы по API держать выключенными. | Да (лицензия не указана — уточнить у автора) |
| 5 | [blacktwist/social-media-skills](https://github.com/blacktwist/social-media-skills) | blacktwist | 568★, обновлён 01.05.2026, MIT [ПРОВЕРЕНО] | 14 скиллов: content-strategy, content-calendar, post-writer, thread-writer, carousel-writer, hook-writer, caption-writer, content-repurposer, performance-analyzer, content-pattern-analyzer и др. Без MCP BlackTwist работает в «советническом режиме». | Хуки, карусели, анализ закономерностей по статистике. | Да; интеграция BlackTwist — отдельный сервис |
| 6 | [claude-skill-social-post](https://github.com/Hao0321/claude-skill-social-post) | Hao (駱君昊) | 736★, обновлён 15.10.2026, MIT [ПРОВЕРЕНО] | Учится вашему голосу и публикует в Facebook, Instagram, Threads, X; строит 14-дневный контент-план; есть правила под Threads. | Автопостинг в несколько сетей и единый голос бренда. Описание на китайском/англ., проверить совместимость с русским. | Да |
| 7 | [threads-carousel-claude-skill](https://github.com/itchernetski/threads-carousel-claude-skill) | itchernetski | 112★, обновлён 19.04.2026, MIT [ПРОВЕРЕНО] | Превращает текстовый пост в карусель-картинки, есть пресет 4:5 для Threads/Instagram. Только генерирует картинки, не публикует. | Карусели «5 причин взять отпариватель», «до/после» из текста. | Да |
| 8 | [HyperFrames (heygen-com/hyperframes)](https://github.com/heygen-com/hyperframes) | HeyGen | 65 076★, обновлён 16.10.2026, Apache-2.0 [ПРОВЕРЕНО]; на skills.sh hyperframes ≈1,0 млн установок, hyperframes-cli ≈1,1 млн | «Пишем HTML — рендерим видео». 21 скилл: анимации (GSAP, Lottie, Three.js), субтитры (/embedded-captions), озвучка/музыка/картинки (/media-use), шаблоны, рабочие процессы «запуск продукта», «объяснялка». Нужны Node 22+ и FFmpeg. | Быстро делать вертикальные ролики и субтитры для Reels/TikTok из кода: плашки с ценой, кинетические титры, «до/после». | Да, без платы за рендер |
| 9 | [Remotion Agent Skills (remotion-dev/skills)](https://github.com/remotion-dev/skills) | Remotion | 5 235★, обновлён 16.10.2026 [ПРОВЕРЕНО]; remotion-best-practices ≈627,6K установок (skills.sh) | Скиллы /remotion-create, -markup, -captions, -render, -studio и др. для видео на React. Установка `npx skills add remotion-dev/skills`. | Альтернатива HyperFrames для видео и субтитров. Лицензия самого Remotion в API помечена «NOASSERTION»; по моим сведениям (не из источников этой сессии), коммерческое использование компаниями выше малого размера платное — **проверить лицензию перед использованием**. | Скиллы да; лицензия Remotion — проверить |
| 10 | [anthropics/skills](https://github.com/anthropics/skills) | Anthropic | 181 537★, обновлён 09.10.2026 [ПРОВЕРЕНО]; frontend-design ≈994,7K установок (skills.sh) | Официальный репозиторий скиллов: canvas-design (картинки/постеры), pptx/xlsx/docx/pdf, skill-creator (создание своих скиллов), frontend-design. | Картинки и афиши, таблицы остатков, создание собственного скилла «Голос Bikas Home» через skill-creator. | Да (лицензия отдельная у каждого скилла) |
| 11 | [threads-api-skill](https://github.com/madebypan/threads-api-skill) | madebypan | 72★, обновлён 14.06.2026, MIT [ПРОВЕРЕНО] | Пошаговая настройка Meta-приложения, долгоживущий токен (~60 дней), публикация веток с картинками, shell-скрипт, перечень ловушек (10+ при настройке, 7 при публикации). | Подключить официальный Threads API к Claude Code без бубна. | Да |
| 12 | [threads-growth-skill](https://github.com/krumjahn/threads-growth-skill) (в каталоге ara.so) | krumjahn / ara.so | 30★; 298 установок на skills.sh; обновлён 14.08.2026 [ПРОВЕРЕНО] | Через автоматизацию браузера читает вашу статистику Threads, находит закономерности, пишет черновики с проверкой «красных линий» и ИИ-тона. Заявляет, что пересылки в личку весят в 3–5 раз больше лайков, ссылаясь на Мосери (2025) — **эту цифру я не подтвердил**. | Разбор своей статистики и адаптация под то, что реально заходит у @bikas.home. | Да (лицензия не указана) |
| 13 | [9 бесплатных скиллов для SMM](https://willfrancis.com/claude-skills-for-social-media-managers-9-free-skills-and-how-to-use-them/) | Will Francis | zip-пакет, звёзд нет | Caption Writer, Content Repurposer, Trend Analyst, Social SEO Researcher, Monthly Content Planner, Hook Generator, Performance Analyst (разбор CSV-выгрузок), Story & Reel Scriptwriter, Campaign Strategist. | Сценарии Reels по секундам и месячный контент-план. Страница тоже маркетинговая (блог агентства). | Да, но нужен платный план Claude |
| 14 | [awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | ComposioHQ | 77 235★, обновлён 18.09.2026 [ПРОВЕРЕНО] | Каталог скиллов и ресурсов. | Место, где искать новое. Репозиторий принадлежит компании Composio, продающей интеграции. | Да |
| 15 | [OpenMontage](https://github.com/calesthio/OpenMontage) и [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) | calesthio; Vincentwei1021 | 68 837★ и 12 168★, обновлены 16.10.2026 (по поиску GitHub) | По описанию GitHub: «открытая агентная система видеопродукции» и скилл для кинематографичных роликов о продукте. **Сами репозитории я не открывал**, только описание из поиска. | Возможно, ролики о товаре: проверить вручную. | Не проверял |

Дополнительно, каталоги для поиска: [skills.sh](https://skills.sh/) (топ-лист), [vibeindex.ai](https://vibeindex.ai/), [claudemarketplaces.com](https://claudemarketplaces.com/). Русскоязычный обзор: [Spilno Agency — скиллы для SMM](https://spilnoagency.com.ua/ru/instructions-ru/claude-skilly-smm-spetsialista) (не читал целиком, только нашёл).

---

## ЧАСТЬ 2. Репозитории и инструменты (10)

Все цифры проверены через GitHub API 16.10.2026 [ПРОВЕРЕНО].

| # | Репозиторий | ★ | Обновлён | Что умеет | Бесплатно |
|---|---|---|---|---|---|
| 1 | [mikusnuz/meta-mcp](https://github.com/mikusnuz/meta-mcp) | 30 | 08.10.2026 | MCP-сервер Instagram Graph API + Threads API (57 инструментов): публикация, карусели, кросспост из Instagram в Threads, аналитика | Да, MIT |
| 2 | [exileum/meta-mcp](https://github.com/exileum/meta-mcp) | 13 | 10.09.2026 | MCP, 19 инструментов Threads: текст, картинки, видео, карусели, ответы, поиск, инсайты, удаление | Да, MIT |
| 3 | [quinnjr/threads-mcp](https://github.com/quinnjr/threads-mcp) | 16 | 15.04.2026 | MCP только для Threads, OAuth 2.0, посты, инсайты, лимиты, кэш, вебхуки | Да, MIT |
| 4 | [madebypan/threads-api-skill](https://github.com/madebypan/threads-api-skill) | 72 | 14.06.2026 | Пошаговый запуск Threads API + скрипт публикации веток | Да, MIT |
| 5 | [gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app) | 37 274 | 16.10.2026 | Открытый планировщик для 28+ соцсетей (в статье автора Threads в списке), есть MCP, CLI и API. Основной автор продаёт облако [РЕКЛАМА в блоге] | Самохостинг бесплатно (AGPL-3.0); облако платное, цены не проверял |
| 6 | [sergebulaev/threads-skills](https://github.com/sergebulaev/threads-skills) | 48 | 15.10.2026 | Скиллы под Threads (см. Часть 1) | Да, MIT |
| 7 | [DevGreenBox/threads-kit](https://github.com/DevGreenBox/threads-kit) | 0 | 13.09.2026 | Русский набор + линтер постов + мониторинг веток через API | Да (лицензия не указана) |
| 8 | [tang-vu/social-posting-skills](https://github.com/tang-vu/social-posting-skills) | 12 | 05.10.2026 | Скилл post-threads + мультиплатформенная публикация | Да, MIT |
| 9 | [greeun/threads-post](https://github.com/greeun/threads-post) | 1 | 23.09.2026 | Скилл Claude Code для Threads API на естественном языке (описание на корейском) | Не проверял лицензию |
| 10 | [itchernetski/threads-carousel-claude-skill](https://github.com/itchernetski/threads-carousel-claude-skill) | 112 | 19.04.2026 | Генератор каруселей из текста | Да, MIT |

Не-GitHub: [Claude Code + Google Apps Script автопостинг (note.com)](https://note.com/ai_jissennkai/n/nd52d4859294c?hl=en) — японский автор показывает схему «Claude Code → Google Таблица/GAS → Threads API», публикация каждые 2 часа (8 постов в день), стоимость Claude от 20 $/мес; статья платная (10 000 иен) [РЕКЛАМА; автор сам признаёт, что просмотров пока мало]. [Фабрика Контента (galson.pro)](https://www.galson.pro/articles/threads-autopilot/) — схема Notion + Claude + агент по крону + Threads API, 20–30 $/мес [РЕКЛАМА, цифры без доказательств].

**Технические факты по Threads API:** токен живёт ~60 дней, между созданием контейнера и публикацией нужно ~30 секунд, картинки нужны по публичной ссылке (из README madebypan). Лимит «250 публикаций в сутки» взят из статьи Галсона и официально мной не проверялся.

---

## ЧАСТЬ 3. Threads: кейсы заработка и методики

### 3.1. Кейсы (9 + живые посты)

| # | Кто / ссылка | Что продаёт | Заявленный результат | Доказательства | Посты в день | Форматы | Механика продажи |
|---|---|---|---|---|---|---|---|
| 1 | [Ангелина Ерофеева, vc.ru](https://vc.ru/id4462432/2772570-kak-privlech-platezhespobosnuyu-auditoriyu-v-threads-i-telegram) | Закрытый Telegram-чат «Лаборатория связок», услуги агентства | За 7 дней +260 подписчиков, 34 тыс. просмотров постов; у учеников «от 110 тыс. до 3 млн ₽» | Скриншоты есть, проверить нельзя; в тексте несостыковки (22 000 подписчиков против 380) [РЕКЛАМА, БЕЗ ДОКАЗАТЕЛЬСТВ] | 3–20 | Короткие мысли, истории, посты с цифрами, комментарии под чужими постами | Threads → ссылка в шапке на Telegram + лид-магнит → чат → платные «связки» |
| 2 | [Екатерина Пахомова, vc.ru](https://vc.ru/id2449157/1833478-kak-privlekat-klientov-bez-byudzheta-s-pomoshyu-threads) | Консультации по Threads | Два анонимных кейса: дизайн-студия «+300 подписчиков и 2 договора», финансовый эксперт «+800 и 5 клиентов» | Нет вообще [РЕКЛАМА, БЕЗ ДОКАЗАТЕЛЬСТВ] | Не указано | Спорные мнения, ответы на популярные посты, мини-серии, вопросы | Трафик в Instagram/Telegram/сайт → консультация |
| 3 | [Юлия Крылова, teletype](https://teletype.in/@juliakrylova/VY6evEbB5S7) | Стратегия по Threads через Telegram (слово «ТРЕДС») | 1-я неделя: охват ~50 тыс., 150 новых людей, 13 подписчиков канала, 50+ веток; выручка не названа | Скриншоты (в тексте не расшифрованы) [РЕКЛАМА] | ~7 (15 минут в день) | Наблюдения, вопросы, ностальгия, спорные мысли, мини-гайды из 5 шагов | Закреп или комментарий со ссылкой на Telegram/бота → канал прогревает и продаёт |
| 4 | [Ира Форс, teletype](https://teletype.in/@irafors/oYg8ynS8l4u) | Статьи и «контент-конструктор» (100+ примеров постов) | ~1 млн просмотров за 1,5 месяца | Один скриншот статистики [РЕКЛАМА, частично БЕЗ ДОКАЗАТЕЛЬСТВ] | до 5–6, иногда 0 | Короткие разговорные посты, юмор (охват), экспертные (подписчики), разборы чужих аккаунтов | Threads → Telegram → бесплатные материалы; отвечает на все комментарии. Критикует «10–20 веток в день» |
| 5 | [Марина (дизайнер), vc.ru](https://vc.ru/marketing/3153831-kak-dizayner-nashyel-klientov-v-threads) | Дизайн под ключ, оформление кейсов на Behance | За 2 недели: ~100 тыс. просмотров, 40 подписчиков, проект на 30 000 ₽ + 400 ₽ | Цифры от самого автора, но с реалистичными провалами (вторая неделя 80–100 просмотров) | пара в день | Личные истории, скриншоты переписок, карусели, комментарии в чужих ветках | Заявки в директ, ссылка в шапке |
| 6 | [Чингис Алекенов (цветы), Tengrinews](https://tengrinews.kz/article/pochemu-kazahi-reshili-threads-ih-sotsset-2025-m-3504/) | Букеты, Казахстан | Продажи за год выросли примерно в 2,5 раза, отказ от таргета ~3 млн ₸/мес | Слова предпринимателя в журналистском материале; рост нельзя целиком отнести к Threads (он ещё менял цены и доставку) | не указано | Честные истории о процессах, ответы на жалобы (курьеры, фото ≠ букет) | Заказы через сайт, WhatsApp, Instagram |
| 7 | [Нуршат Акбергенова (кондитер), та же статья](https://tengrinews.kz/article/pochemu-kazahi-reshili-threads-ih-sotsset-2025-m-3504/) | Кондитерские | Пост о неоплаченном заказе: 1,2 млн просмотров | Сама говорит, что коммерческого успеха это не принесло | — | История-конфликт | — |
| 8 | [Azhar Ahmed, Sell Ideas](https://sellideas.beehiiv.com/p/how-i-went-from-0-sales-to-consistent-income-on-threads-in-5-simple-steps) | Гайд по росту в Threads + шаблоны + 500 промтов | 0 продаж 8 месяцев, потом «стабильно»; 9 500 подписчиков, 8,0 млн просмотров за 90 дней | Скриншот; сумм продаж нет [РЕКЛАМА] | «каждый день» | Контент-польза, показ результатов, прямые призывы | Ссылка (Beacons) на платный гайд + бесплатная версия |
| 9 | [Юлия из Гомеля, Наша Ніва](https://nashaniva.com/ru/387976) | Украшения из живых цветов | Пост на белорусском: >1 000 лайков за сутки, ~100 комментариев | Данных о продажах нет | — | Фото работ + пост на языке аудитории | не описано |

**ИИ/Claude-кейсы:** [Илья Филиппов (blog.fillikam.com)](https://blog.fillikam.com/guides/threads-s-neyrosetyu/) — продаёт мини-курс «Claude за вечер»; своих результатов по Threads не показывает [РЕКЛАМА]. [Макс Галсон](https://www.galson.pro/articles/threads-autopilot/) — «Фабрика Контента», рекомендует 2–3 поста в день (пики 9:00, 13:00, 21:00 МСК по его статистике), «охваты +40%» без базовых цифр [РЕКЛАМА]. Сквозной вывод всех трёх ИИ-источников: Claude полезен для черновиков и серий, но **публикуемые тексты нужно вычитывать от «ИИ-стиля»**, а не публиковать как есть.

### 3.2. Пять самых сильных постов (живые, прочитаны 16.10.2026) [ПРОВЕРЕНО]

Тексты не копирую целиком (см. оговорку), передаю суть и точные цифры.

1. **[@amina.aliaidarova, 10.12.2025](https://www.threads.com/@amina.aliaidarova/post/DSEpSLCCGLg)** — короткий пост-представление с фото моющего пылесоса и концовкой в одну строку. Цифры: **338 035 просмотров, 3 321 лайк, 64 ответа, 60 репостов, 1 256 отправок.** Продажа: первым же ответом автор ставит ссылку на карточку товара в Kaspi.kz (закреплена). В комментариях люди задают вопросы о товаре и спорят об уходе. Это **самый близкий к нашему магазину пример**: бытовой товар, Казахстан, Kaspi, ссылка в ответе, а не в посте.
2. **[@dmitriyinin, 12.07.2026](https://www.threads.com/@dmitriyinin/post/Dasi--IicpP)** — подпись «Higgsfield + Claude» с видео сайта, собранного нейросетями. **239 462 просмотра, 5 554 лайка, 114 ответов, 415 репостов, 1 178 отправок.** Продажа: в первом ответе ссылка на whop.com (платный «промт + ZIP сайта»). Подтверждает схему: вирусное видео в посте, продающая ссылка в самоответе.
3. **[@grozzari, 26.09.2026](https://www.threads.com/@grozzari/post/DdwAi0FiNMR)** — восклицательный пост «Threads работает»: объявление на Авито висело полгода, а здесь вещь продана за 4 дня, приглашение писать в комментарии, что кому продать. **87 786 просмотров, 414 лайков, 770 ответов, 5 репостов, 32 отправки.** Ответы: продавцы (лампы из хрусталя, чемоданы, винтажные часы и т. п.). Автор одного из ответов пишет, что охваты хорошие, но продать ничего ещё не удалось.
4. **[@alona_blondi, 04.10.2026](https://www.threads.com/@alona_blondi/post/DeEQmZnDaHZ)** — «ВЕТКА САМОРЕКЛАМЫ»: пожелание клиентов в октябре и просьба написать, чем занимаешься. **48 177 просмотров, 381 лайк, 647 ответов.** Сама автор сразу отвечает подробным описанием товаров, а во втором ответе даёт ссылку на группу с ценами.
5. **[@makpal_samat_, 19.01.2026](https://www.threads.com/@makpal_samat_/post/DTsZJfmCCAP)** — «Давайте продвинем ветку, увеличим друг другу продажи (пишите, кто что продаёт)». **42 648 просмотров, 363 лайка, 652 ответа.** Ответы — продавцы из Казахстана и России (портреты, одежда, химчистка и т. п.), один пишет, что «продаёт опыт не покупать всё подряд в таких ветках».

Ещё два для контекста: [@nail_anastasiya.a, 18.09.2026](https://www.threads.com/@nail_anastasiya.a/post/Ddaf-GoiHIW) — «Не удивляйтесь, если у вас появятся клиенты из этой ветки», Астана: 36 207 просмотров, 309 лайков, 664 ответа. [@kozlovskayaox, 01.10.2026](https://www.threads.com/@kozlovskayaox/post/Dd9b2hFDEJl): «первые клиенты из Threads», 2 994 просмотра, 115 лайков, 27 ответов — комментаторы в основном шутят и сомневаются, оплата не подтверждена.

**Что из этого видно (мои наблюдения, не утверждения авторов):**
- «Ветки саморекламы» дают огромные просмотры и сотни ответов, но отвечают в основном такие же продавцы. Реальные продажи подтверждены редко: один автор писал, что продала вещь, другой — что охваты есть, продаж нет, третий — «Кто эти люди, у которых покупают через Threads?» (105 лайков, 243 ответа).
- Работающая для товаров схема: **небытовой, живой пост с товаром + ссылка на карточку Kaspi/магазин в самоответе** (пример Амины).
- Покупатели из Threads пишут отзывы-благодарности: [@gulnaz_zhakipbekova](https://www.threads.com/@gulnaz_zhakipbekova/post/Dej4dIkn4lU) купила пылесос после ветки в Threads и поставила ссылку Kaspi (на момент чтения всего 34 просмотра).
- Много запросов покупателей без продавца: «Кто какие находки для дома посоветует» (например [@gf.azhar](https://www.threads.com/@gf.azhar), Астана, 188 лайков; [@skala.v.interiere](https://www.threads.com/@skala.v.interiere), 61 лайк и 188 ответов). Это входы для полезных ответов от Bikas Home, без спама.

### 3.3. Что продвигает алгоритм Threads

**Официально подтверждено Meta:**
- [Meta Transparency Center, обновлено 07.03.2025](https://transparency.meta.com/features/explaining-ranking/ig-threads-feed): лента = аккаунты, на которые вы подписаны, + рекомендации; система предсказывает вероятность лайка, ответа, клика на пост/профиль, времени на посте, пролистывания. В сигналах — недавняя активность, ваша вовлечённость в ответы второго уровня, свежесть. Это объясняет, почему ответы и обсуждения важны. Про частоту, время суток, ссылки и видео в документе **ничего нет**.
- Адам Мосери (июнь 2025): ссылки теперь ранжируются «правильно», работают лучше уже больше месяца ([Social Media Today](https://www.socialmediatoday.com/news/meta-says-link-posts-ranked-properly-threads-reach/750126/)). Это не значит, что они получают больше охвата.
- [«Dear Algo», февраль 2026](https://about.fb.com/news/2026/02/threads-dear-algo/): пользователь пишет публичный пост, и лента подстраивается примерно на три дня. Доступно в США, Новой Зеландии, Австралии, Великобритании, остальное «скоро» (Казахстан не указан).
- Meta заявляла о борьбе с приманками на вовлечение ([Engadget](https://www.engadget.com/social-media/meta-is-working-to-fix-threads-engagement-bait-problem-173135011.html), дата не указана, не открывал сам, со слов обзора).

**Исследования и мнения (не официальные):**
- [Buffer, 24.02.2026](https://buffer.com/resources/threads-comments-engagement/): в выборке более 128 тыс. постов у авторов, отвечающих на комментарии, вовлечённость выше на ~42% (корреляция, не причинность).
- Обзоры [Metricool](https://metricool.com/threads-algorithm/) и [Bulkpublish](https://www.bulkpublish.com/blog/threads-algorithm/) отдельно оговаривают: частота («пост в день»), время суток, популярность видео/картинок и «алгоритм не любит ссылки» — не подтверждены Meta. Bulkpublish называет последнее самым часто повторяемым и наименее подтверждённым утверждением.
- Советы авторов: 1–3 поста в день (Филиппов), 2–3 (Галсон), до 5–6 (Форс), критика «10–20 веток в день». Единого подтверждённого значения нет.
- Лимит на длину поста — 500 символов (технический лимит платформы, не фактор ранжирования); в Threads есть вложенный текст до 10 000 символов ([postium.ru](https://postium.ru/vetki-v-threads/), непроверенный блог).

**Практический вывод:** ссылку лучше ставить во втором сообщении (так делают самые просматриваемые посты выше и так советуют threads-kit и threads-skills, хотя прямого запрета на ссылку в первом посте Meta не вводила); отвечать на комментарии в первый час; не писать приманки «ставь лайк/пиши +».

---

## ЧАСТЬ 4. Промты и настройки

Ниже источники, где я нашёл реальные инструкции. Тексты открытых MIT-репозиториев можно скопировать прямо из файлов по ссылкам.

1. **Правила голоса Threads из [sergebulaev/threads-skills](https://github.com/sergebulaev/threads-skills)** (MIT, открытый README) — семь правил, которые соблюдают все 8 скиллов: без длинных тире (главный признак ИИ); имена с заглавной буквы; без «ИИ-слов» (leverage, delve и т. д.); конкретные числа вместо прилагательных; одна идея на пост, вся суть в первой строке (лента обрезает текст); до 500 знаков, 0–1 хэштег, 0–2 эмодзи; тон тёплый разговорный, без «колких» постов в стиле X. Хуки: 13 формул в `references/hook-formulas.md` — для ответов (признание, «любопытный зазор», тёплое несогласие, «я первый»), для репостов (цифра, мини-список, ветка-список, разбор «как я», микро-урок), для лайков (узнаваемое начало, история), для цитат (добавить ценность, смена рамки). Автор сам отмечает, что три формулы — гипотезы.
2. **Инструкция [DevGreenBox/threads-kit](https://github.com/DevGreenBox/threads-kit)** (по README, лицензии нет): Claude обязан сначала собрать профиль (≈10 вопросов), главное — «банк фактов» со своими цифрами и реальными случаями; ссылка не в первом посте, а в ответе на него; ответ весит больше лайка, поэтому пост строится на разговоре; публиковать, когда сможете отвечать в первый час; не больше 1 хэштега; до 500 знаков; линтер блокирует канцелярит, приманки, «ИИ-признаки». Для автоответов: не более 40 в сутки, паузы 10+ минут, один ответ на ветку.
3. **Пять промтов из [блога Ильи Филиппова](https://blog.fillikam.com/guides/threads-s-neyrosetyu/)** [РЕКЛАМА его курса; полные тексты в блоке кода на странице, я их не копирую]: (а) сжать сырую мысль в пост ≤500 знаков, крючок в первых 175, без хэштегов и эмодзи, на «ты», с подсчётом длины в конце; (б) 7 вариантов первой строки ≤120 знаков (спорное утверждение, цифра из практики, вопрос-боль, обещание); (в) серия из 7 постов: хук → шаги → итог с приглашением обсудить; (г) переупаковка поста из Telegram в серию из 6–8 постов с мягкой продажей; (д) выбор типа хука из пяти и три варианта. Автор отдельно советует проверять длину вручную, потому что модель ошибается в подсчёте символов.
4. **Промт для идей из [«Фабрики Контента» Галсона](https://www.galson.pro/articles/threads-autopilot/)** [РЕКЛАМА]: первая строка «Сгенерируй 10 идей для постов в Threads на тему [..]», дальше формат (короткий хук + основная мысль) и стиль (разговорный, от первого лица). Структура поста: хук → боль → инсайт → личный опыт → вопрос, до 400 знаков. Для голоса Claude читает файл с 50+ одобренными постами (это не дообучение).
5. **10 универсальных промтов [Blotato](https://www.blotato.com/blog/claude-prompts-social-media)** [РЕКЛАМА сервиса публикации; сами промты работают в обычном чате Claude]: календарь на 30 дней, преобразование длинного текста под соцсети (для Threads: личный тон, без хэштегов), клон голоса по 5 постам, карусель из 7 слайдов, три варианта подписи с разными хуками, 5 сценариев по 45–60 с из длинного источника, ответы на комментарии, хэштеги, разбор конкурентов, недельный батч.

**Мой черновик системной инструкции для Bikas Home** (собран из пунктов 1–4, это мой синтез, не чужая цитата):

> Ты ведёшь Threads магазина Bikas Home (ручной отпариватель и товары для дома, Казахстан). Пиши по-русски, тёплым разговорным тоном, от лица владельца. До 500 знаков в посте, вся суть в первой строке, 0–1 хэштег, без длинных тире и «ИИ-фраз». Опирайся только на реальные факты из банка фактов (цены в тенге, отзывы покупателей, ситуации из жизни). Ссылку на карточку Kaspi или сайт ставь не в первый пост, а во второй (самоответ). Не пиши «ставь лайк» и не используй приманки на вовлечение. Каждый пост заканчивай вопросом или поводом ответить. Объём: 2–3 поста в день, остальное время — полезные ответы под запросами покупателей («находки для дома», «посоветуйте отпариватель»), без спама.

---

## ЧАСТЬ 5. Выводы: 10 находок по пользе для Bikas Home

1. **Схема «живой пост с товаром + ссылка на Kaspi во втором сообщении»** (пост Амины про пылесос: 338 тыс. просмотров, Kaspi в самоответе) → это прямой шаблон для отпаривателя; тестировать на 5–10 постах.
2. **Подключить уже доступные скиллы social-media-skills (threads-post, threads-growth, hook-writer, carousel-writer, reels-script)** → хуки, ветки, сценарии Reels/TikTok без установки новых наборов.
3. **Заходить в ветки-запросы покупателей («находки для дома», «посоветуйте…»)** с полезным ответом, а не рекламой → бесплатный тёплый трафик (в одном поиске нашлось несколько таких веток по 75–190 лайков).
4. **Не рассчитывать на «ветки саморекламы» как на продажи** → дают охват (36–88 тыс. просмотров), но отвечают в основном такие же продавцы, подтверждённых продаж почти нет.
5. **Банк фактов + правила голоса (threads-skills, threads-kit)** → Claude пишет тексты со своими цифрами и без «ИИ-стиля», который читатели узнают и не любят (так же советуют Марина-дизайнер и Ира Форс).
6. **Ответы на комментарии в первый час** (Buffer: ~+42% вовлечённости, корреляция) → Claude может готовить черновики ответов, а отправлять лучше вручную или с лимитами threads-kit.
7. **HyperFrames (или Remotion) для Reels/TikTok** → шаблоны роликов, кинетические субтитры и озвучка из кода без монтажа вручную; бесплатно, Apache-2.0.
8. **Официальный Threads API через MCP (mikusnuz/meta-mcp или exileum/meta-mcp) или Postiz** → автопубликация и статистика без ручной работы; токен живёт ~60 дней, нужно обновление.
9. **Карусели из текста (itchernetski, carousel-writer)** → одна идея превращается в пост Threads + карусель Instagram + фото-пост TikTok.
10. **Скептически относиться к «кейсам на миллионы»** (Ерофеева, Пахомова, Крылова и др.) → почти все — реклама курсов; реалистичные цифры у Марины (30 000 ₽ за 2 недели) и Азара (8 месяцев без продаж).

---

## Ссылки по частям

### Часть 1
- https://github.com/coreyhaines31/marketingskills
- https://github.com/social-media-skills/skills
- https://github.com/sergebulaev/threads-skills
- https://github.com/DevGreenBox/threads-kit
- https://github.com/blacktwist/social-media-skills
- https://github.com/Hao0321/claude-skill-social-post
- https://github.com/itchernetski/threads-carousel-claude-skill
- https://github.com/heygen-com/hyperframes
- https://github.com/remotion-dev/skills
- https://www.remotion.dev/docs/ai/skills
- https://github.com/anthropics/skills
- https://github.com/madebypan/threads-api-skill
- https://github.com/krumjahn/threads-growth-skill
- https://www.skills.sh/aradotso/marketing-skills/threads-growth-skill
- https://willfrancis.com/claude-skills-for-social-media-managers-9-free-skills-and-how-to-use-them/
- https://github.com/ComposioHQ/awesome-claude-skills
- https://github.com/calesthio/OpenMontage
- https://github.com/Vincentwei1021/video-shotcraft
- https://skills.sh/
- https://spilnoagency.com.ua/en/instructions-us/claude-skills-for-threads
- https://spilnoagency.com.ua/ru/instructions-ru/claude-skilly-smm-spetsialista

### Часть 2
- https://github.com/mikusnuz/meta-mcp
- https://github.com/exileum/meta-mcp
- https://github.com/quinnjr/threads-mcp
- https://github.com/gitroomhq/postiz-app
- https://github.com/tang-vu/social-posting-skills
- https://github.com/greeun/threads-post
- https://note.com/ai_jissennkai/n/nd52d4859294c?hl=en
- https://www.galson.pro/articles/threads-autopilot/
- https://postiz.com/blog/automate-social-media-claude-code-ai-agents

### Часть 3
- https://vc.ru/id4462432/2772570-kak-privlech-platezhespobosnuyu-auditoriyu-v-threads-i-telegram
- https://vc.ru/id2449157/1833478-kak-privlekat-klientov-bez-byudzheta-s-pomoshyu-threads
- https://teletype.in/@juliakrylova/VY6evEbB5S7
- https://teletype.in/@irafors/oYg8ynS8l4u
- https://vc.ru/marketing/3153831-kak-dizayner-nashyel-klientov-v-threads
- https://tengrinews.kz/article/pochemu-kazahi-reshili-threads-ih-sotsset-2025-m-3504/
- https://sellideas.beehiiv.com/p/how-i-went-from-0-sales-to-consistent-income-on-threads-in-5-simple-steps
- https://nashaniva.com/ru/387976
- https://postium.ru/vetki-v-threads/
- https://www.threads.com/@amina.aliaidarova/post/DSEpSLCCGLg
- https://www.threads.com/@dmitriyinin/post/Dasi--IicpP
- https://www.threads.com/@grozzari/post/DdwAi0FiNMR
- https://www.threads.com/@alona_blondi/post/DeEQmZnDaHZ
- https://www.threads.com/@makpal_samat_/post/DTsZJfmCCAP
- https://www.threads.com/@nail_anastasiya.a/post/Ddaf-GoiHIW
- https://www.threads.com/@kozlovskayaox/post/Dd9b2hFDEJl
- https://www.threads.com/@gulnaz_zhakipbekova/post/Dej4dIkn4lU
- https://transparency.meta.com/features/explaining-ranking/ig-threads-feed
- https://about.fb.com/news/2026/02/threads-dear-algo/
- https://www.socialmediatoday.com/news/meta-says-link-posts-ranked-properly-threads-reach/750126/
- https://www.engadget.com/social-media/meta-is-working-to-fix-threads-engagement-bait-problem-173135011.html
- https://buffer.com/resources/threads-comments-engagement/
- https://metricool.com/threads-algorithm/
- https://www.bulkpublish.com/blog/threads-algorithm/
- https://blacktwist.app/blog/how-the-threads-algorithm-works-in-2026-based-on-meta-s-updates

### Часть 4
- https://blog.fillikam.com/guides/threads-s-neyrosetyu/
- https://www.blotato.com/blog/claude-prompts-social-media
- https://github.com/sergebulaev/threads-skills
- https://github.com/DevGreenBox/threads-kit
- https://www.galson.pro/articles/threads-autopilot/

### Не удалось открыть
- https://secrets.tbank.ru/trendy/skandaly-brendov-v-threads/ (сайт запрещает чтение роботам)
- https://lobehub.com/skills/ungurenko-claude-config-threads-content-factory (ошибка загрузки)
