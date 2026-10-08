# Контракт v1

TypeScript + официальный MCP SDK v2, stateless Streamable HTTP с JSON responses.
Express обслуживает OAuth, discovery, MCP endpoint и отдельно аутентифицированный
Telegram ingress. OAuth persistence и контентный FTS5-индекс находятся в отдельной
SQLite базе. Существующие сайты, базы, WordPress plugins и боты не модифицируются.

Поток данных:

1. Клиент получает MCP-specific opaque token через browser login HearthPulse.
2. Каждый MCP-запрос сначала проверяет grant, срок, resource и текущую admin-сессию.
3. `src/tools.ts` регистрирует только фиксированные операции чтения.
4. Структурированные данные читаются через upstream API по запросу; статьи/страницы/
   посты доступны через обновляемый локальный индекс и точечный fetch WordPress.
5. Каждый результат tools имеет `retrievedAt`; материалы имеют source URL, даты,
   `fetchedAt` и `metadata.access`. Исходные статистические filters сохраняются.

Данные с разных сайтов не схлопываются по одному заголовку: source + external ID
составляют identity, ссылки/canonical сохраняют provenance. WordPress HTML обогащает
raw-материал, не заменяя его платный body публичным teaser. Индексированная версия
обновляет FTS атомарно. Русский полнотекстовый поиск использует Unicode tokenizer,
без semantic/vector search в этой версии.

Пагинация: Koloda `after`/`nextCursor` (не сочетать с nonzero offset), индекс и VK
`offset`/`nextOffset`, Boosty upstream offset; text chunks `textOffset`/`nextOffset`.
Максимум 200 database rows, 128 KB tool JSON, 16k символов в text chunk. Большой
record field выдаётся отдельно. Уменьшайте limit/fields при `RESULT_TOO_LARGE`.

Source adapters изолированы от OAuth. Source errors показывают отсутствие доступа/
контракта вместо поддельной успешной загрузки. Нет service write tools, произвольного
SQL, GraphQL mutation, публикации сообщений, управления пользователями или scraper jobs.

Plausible Stats API v2 читается по запросу через фиксированный `/api/v2/query`,
отдельный stats-only key и allowlist сайтов. `metrics`/`dimensions` подписывают
массивы значений, `meta` сохраняет предупреждения, `nextOffset` продолжает выдачу.
Сырые посещения в индекс не копируются. Лимит — 100 строк на запрос.

Один процесс должен владеть базой и выполнять ingestion; отдельно `npm run ingest`
можно запускать при остановленном встроенном importer. Для масштабирования потребуется
отдельный worker/queue и shared OAuth persistence вместо копирования SQLite replicas.
