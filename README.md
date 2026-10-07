# Manacost MCP

MCP для сайтов Manacost, полной разрешённой базы Koloda, Telegram, Boosty и VK.
Доступ получают только действующие администраторы HearthPulse после входа через
его существующий профиль. Все MCP-инструменты предназначены только для чтения.

**Рабочий адрес: https://hearthpulse.net/mcp.** Подключение Codex и Claude Code:
`npm run connect` из checkout на машине клиента. Первый вход выполняется в
браузере через HearthPulse. [Инструкции для всех клиентов](docs/clients.md).

## Что подключено

| Источник | Данные и способ подключения |
| --- | --- |
| `api.kolodahearthstone.com` | GraphQL: все разрешённые таблицы/views в `catalog`, `analytics`, `raw`, `platform`, `hub`, включая колонки и cursor pagination; REST для карт и колод |
| `hs-manacost.ru` | WordPress статьи, страницы, категории, теги; sitemap, HTML, навигация и SEO |
| `kolodahearthstone.com` | То же, **включая полный платный текст** через приватный локальный reader или WordPress Application Password и `context=edit` |
| `old.kolodahearthstone.ru` | WordPress при доступности; RSS, sitemap и HTML для архива; возможен импорт полного экспорта |
| `hearthpulse.net` | Каталог статей, страницы сайта и маркетинговые метаданные; статистика через существующий API |
| Telegram | Посты и правки из текущего обработчика вашего бота; импорт сохранённой истории |
| Boosty `kolodahearthstone` | Каталог постов, доступный текст; существующий локальный API подписок/retention и продаж постов |
| VK `manacost` | Лента сообщества, доступные счётчики вовлечённости, описание и публичные ссылки через VK API |

Telegram `manacost_ru` читается из публичного архива с постепенной загрузкой истории.
Для forwarding ботом нужны numeric channel IDs и отдельный секрет. VK требует
действующего API token; без него источник явно отмечается как не настроенный.

## Запуск

Требуется Node.js 22+, Nginx и существующий HearthPulse. Production-инсталляция
сервисов не выполняется при `git push`.

```bash
npm ci
cp .env.example .env
openssl rand -hex 32
# Запишите результат в SESSION_ENCRYPTION_KEY в .env и настройте источники.
chmod 600 .env
npm run check
npm run build
npm start
```

Используйте reverse proxy на **том же origin**, что и HearthPulse:
`https://hearthpulse.net/mcp`. Login cookie HearthPulse является host-only;
другой поддомен не получит её. Готовые примеры: [Nginx](deploy/nginx.conf),
[systemd](deploy/manacost-mcp.service), [Docker Compose](compose.yaml).
Ничего из этих файлов не устанавливается автоматически.

После запуска подключите URL `https://hearthpulse.net/mcp` в клиенте с поддержкой
OAuth для удалённого MCP. Войдите в HearthPulse под администратором и подтвердите
чтение. Пароль и cookie не передаются MCP-клиенту.

## Инструменты

| Инструменты | Назначение |
| --- | --- |
| `search_content`, `get_content` | Единый индекс материалов и постов; полный текст читается частями по `nextOffset` |
| `get_wordpress_content` | Полный текст статьи/страницы по WordPress ID сразу, не дожидаясь обхода индекса |
| `get_site_overview`, `list_site_pages`, `get_content_metadata` | Структура сайта, навигация, SEO, категории, платные материалы и прогресс обхода; метаданные читаются отдельными страницами |
| `list_collections`, `describe_collection`, `read_records` | Вся база, разрешённая Koloda API; без SQL и мутаций |
| `read_record_field` | Большое поле записи частями |
| `search_database`, `search_cards`, `search_decks` | Игровые каталоги и колоды |
| `get_statistics` | Статистика HearthPulse; история/raw доступны через коллекции Koloda |
| `list_boosty_posts`, `get_boosty_analytics` | Посты Boosty, подписки, retention и агрегаты продаж |
| `list_vk_posts`, `get_vk_community` | VK-посты, вовлечённость и информация о сообществе |
| `get_source_status` | Свежесть, ошибки, покрытие и готовность конфигурации |

Примеры задач для AI:

- «Сравни позиционирование HearthPulse, Manacost и Koloda по их страницам и меню».
- «Найди платные гайды Koloda по Арене и прочитай полный текст».
- «Посмотри наши Boosty-посты и продажи за месяц; предложи темы для продвижения».
- «Сравни темы Telegram и VK с темами наших статей».

SEO, OpenGraph, заголовки, изображения, ссылки и JSON-LD доступны в `metadata`
индексированных страниц; WordPress-статьи дополнены HTML-метаданными после обхода.
Размер индекса не является посещаемостью сайта. Посещаемость/конверсии сайтов не
выдумываются: интеграции с Метрикой/GA в этой версии нет.

## Полный платный текст

Настройте `KOLODA_WP_USERNAME` и `KOLODA_WP_PASSWORD` отдельным WordPress
Application Password для аккаунта с правом чтения/редактирования нужных статей.
Адаптер читает **`content.raw`**, сохраняет тело VIP-шорткодов и JSON-атрибут
`content` блоков `svl/locker`. Коды разблокировки удаляются. Без серверного доступа
весь платный текст не объявляется загруженным: состояние показывает
`PAID_CONTENT_CREDENTIALS_REQUIRED`, а публичные отрывки помечены `access=excerpt`.
Запрос полного материала без credentials завершается явной ошибкой.

## Индекс и ограничения источников

Первичный импорт проходит постепенно: страницы WordPress, taxonomy pages и
sitemap frontier сохраняют прогресс в SQLite; HTML-страницы обходятся ограниченными
пакетами. `get_source_status` и `list_site_pages` показывают реальное покрытие.
`npm run ingest` запускает один цикл; `WP_PAGES_PER_SYNC` и `HTML_PAGES_PER_SYNC`
регулируют размер пакета. Циклы не запускаются одновременно в одном процессе.

- Старый сайт может не отдавать WordPress JSON; HTML/RSS дают только доступное
  содержимое. Для полного закрытого архива используйте безопасный JSONL-экспорт.
- Bot API не выдаёт старую историю Telegram. Подключение текущего бота и импорт
  истории описаны в [sources.md](docs/sources.md).
- Локальный Boosty API сейчас содержит аналитику, но не полный каталог постов.
  Каталог читается отдельным адаптером к веб-API Boosty. Этот upstream не имеет
  стабильного публичного контракта; его формат и доступность надо проверить на
  запуске. Ошибка источника не скрывается. Без доступа к платному Boosty-посту
  возвращается явно помеченный отрывок.
- Для VK нужен собственный API-токен с доступом к чтению сообщества. Без него
  источник отображает `VK_TOKEN_NOT_CONFIGURED`.
- Удаление публикаций не является гарантированным зеркалом: Bot API не присылает
  обычные удаления channel posts, а удалённые WordPress/социальные записи могут
  оставаться в локальном историческом индексе. Для требований к точному зеркалу
  нужны соответствующие события удаления/сверка.

## Проверки и документация

`npm run check` выполняет TypeScript typecheck, тесты и сборку. Тесты используют
фикстуры вместо внешних premium/API запросов. Интеграционный тест проходит реальный
HTTP MCP handshake официальным клиентом SDK.

- [Авторизация и модель доступа](docs/security.md)
- [Настройка источников и Telegram](docs/sources.md)
- [Запуск и откат](docs/deployment.md)
- [Контракт и архитектура](docs/architecture.md)

Секреты, production-базы, `.env`, cookies и экспорты не входят в репозиторий.
