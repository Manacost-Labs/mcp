# Источники

## Koloda database

Создайте серверный token со scope `database:read` в существующем Koloda API и
запишите его в `KOLODA_API_TOKEN`. Не используйте `admin`, `tokens:manage` или
orchestrator credentials. MCP использует documented GraphQL roots `collections`,
`records`, `search`; схемы, строки и cursor выдаёт существующий API. MCP не читает
SQL-файлы, не подключается напрямую к PostgreSQL и не меняет publication gates.
Все таблицы/views, которые разрешает upstream, доступны без дополнительного
придуманного allowlist. Payloads слишком больших полей читаются через
`read_record_field`. Содержимое неизвестного поля возвращается как source data.

## WordPress / маркетинговый контекст

Отдельные Application Passwords на каждом сайте настраиваются парами
`MANACOST_WP_*`, `KOLODA_WP_*`, `OLD_KOLODA_WP_*`. Они передаются только origin
соответствующего `/wp-json/wp/v2` и не пересылаются при редиректах. Production
origin должен корректно передавать Authorization WordPress/PHP.

В этой версии сканируются опубликованные posts/pages. Полный доступ к платным
статьям через raw content не означает автоматического индексирования drafts или
пользователей. Для редакционного экспорта нестандартных post types используйте JSONL.
WordPress категории/теги пагинируются; sitemap и ссылки меню дополняют структуру.
HTML capture включает canonical, description, robots, OpenGraph, h1-h3, ссылки,
навигацию, изображения и JSON-LD. Ни cookies посетителей, ни настройки CMS, ни
история админки для маркетинговой задачи не извлекаются.

HearthPulse `/api/articles` отдаёт каталог/отрывки; полные оригиналы доступны в
адаптерах WordPress. `HEARTHPULSE_API_KEY` — отдельный сервисный ключ публичного API
HearthPulse, используется только для игровых statistics endpoints.

## Telegram: текущий бот

1. Укажите channel IDs в `TELEGRAM_CHANNEL_IDS`. Ссылка `t.me/manacost_ru` найдена
   на Manacost; numeric ID берётся из уже полученного ботом `channel_post.chat.id`.
2. Создайте `TELEGRAM_INGEST_SECRET` (не менее 32 символов).
3. В **существующем** обработчике updates бота после его обычной обработки
   поставьте пересылку `channel_post` и `edited_channel_post` в durable queue.
4. Worker очереди отправляет исходный Update JSON:

```http
POST /mcp/ingest/telegram
Content-Type: application/json
X-Manacost-Ingest-Secret: <shared-secret>
```

Отправлять можно на локальный `http://127.0.0.1:3100/mcp/ingest/telegram`;
сам ingress уже проверяет секрет и allowlist. Не выводите заголовок в логи.
Повторяйте неуспешные запросы из очереди, подтверждайте только после HTTP 200.
Update IDs дедуплицируются, edits обновляют сообщение и FTS; более старый update
не откатывает текст. Медиа сохраняются как ссылки/идентификаторы, не скачиваются.
Существующий webhook/getUpdates не переключается, второй потребитель не создаётся.
В репозитории не выполняются `setWebhook`, `getUpdates` или операции отправки сообщений.

Историю сначала возьмите из текущей базы бота. Bot API не предоставляет весь архив.
Для нужного периода допустим одноразовый Telegram export/авторизованный MTProto
импорт, но этот сервис не запускает пользовательскую Telegram-сессию автоматически.

```bash
npm run import -- telegram-updates /secure/export/updates.jsonl
npm run import -- content /secure/export/content.jsonl
```

Формат `content`: одна JSON-строка на материал:

```json
{"source":"telegram","externalId":"channel:message","url":"https://t.me/manacost_ru/123","title":"Заголовок","text":"Полный текст","publishedAt":"2026-10-01T10:00:00Z","metadata":{"kind":"post","access":"full"}}
```

Экспорты содержат приватные данные, хранятся вне Git и не используются как тестовые
fixtures. Клиентские MCP tools не могут запускать import или менять индекс.

## Boosty

`BOOSTY_LOCAL_URL=http://127.0.0.1:18082` подключает найденный серверный Boosty API:
`GET /api/analytics` и `GET /api/boosty/sales/analytics`. В Docker используется host
network, чтобы loopback оставался loopback сервера. Запросы read-only, без запуска
poll/export или изменения существующей Boosty-сессии. Выручка/retention сохраняют
семантику upstream. Post-sales показывает **проданные** посты за период; это не
полный каталог публикаций.

Каталог: `BOOSTY_BLOG=kolodahearthstone`, отдельный adapter web-API Boosty
`/v1/blog/{blog}/post/`; `pagination.offset` передаётся в следующий запрос. Без
доступа к полному платному телу оно помечается excerpt. Опциональный
`BOOSTY_CONTENT_TOKEN` настраивается владельцем, не извлекается из существующих
session files. Доступность этого endpoint и его неофициальный контракт нуждаются
в live-проверке при запуске. Сервис не подменяет ошибку каталога sales-списком.

## VK

`VK_COMMUNITY=manacost` найдена по ссылке `vk.com/manacost`. Настройте собственный
`VK_API_TOKEN`, подходящий для чтения сообщества, и `VK_API_VERSION` (по умолчанию
5.199). Методы: `wall.get` и `groups.getById`; токен передаётся в POST body,
не в логируемом URL. Публикаций, likes или действий над сообществом сервис не делает.
Если token/права отсутствуют или upstream запрещает чтение, источник сообщает ошибку.
Обычные публичные counts не эквивалентны полной приватной аналитике VK.
