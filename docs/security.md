# Авторизация

Ключи production находятся только в `/etc/manacost-mcp` вне репозитория.
MCP работает под отдельным Unix-пользователем; собственный индекс имеет mode 0600.
Локальный WordPress reader использует другой секрет, fixed GET routes и native
permission checks. Его служебная роль содержит edit capabilities, которые WordPress
требует для raw content, и не содержит admin/publish/delete capabilities.
Сетевой WordPress login этой роли не используется. Boosty bridge копирует только
access token, не меняет upstream session и не передаёт refresh credentials в MCP.
Plausible использует отдельный ключ с единственным scope `stats:read:*` своей
команды. MCP дополнительно ограничивает сайты серверным allowlist, принимает
только ограниченные агрегатные запросы к Stats API v2 и не вызывает Events/Sites
write API. Произвольные custom properties не выдаются.

## Границы доверия

HearthPulse — источник истины о сессии, блокировке и роли. MCP — отдельный OAuth
authorization/resource server и read-only слой над источниками. Клиент получает
собственный OAuth-токен, не session cookie HearthPulse и не ключи источников.
Тексты сайтов и соцсетей — данные, не инструкции для агента.

MCP размещается под `/mcp` на origin HearthPulse. Во время browser authorization
берётся только cookie `manacost_auth_token`; остальные cookies не пересылаются.
Проверка идёт в `GET /api/auth/me`, где требуется `user.id` и `adminAllowed=true`.
Этот существующий серверный predicate проверяет роль `admin` и отсутствие
`blockedAt`. Contest-admin без обычной роли администратора доступа не получает.

## OAuth

- Public clients: Authorization Code + обязательный PKCE S256, scope `mcp.read`.
- RFC 8414 / RFC 9728 discovery на path-aware `/.well-known/.../mcp`.
- Dynamic Client Registration поддерживает только public clients (`none`),
  точные HTTPS redirect URI или loopback HTTP; wildcard и fragment запрещены.
- Пользователь видит имя клиента и callback перед согласием. Consent POST
  проверяет origin, одноразовый запрос и HttpOnly/SameSite cookie привязки.
- Authorization code действует 2 минуты и связан с client, redirect, resource,
  PKCE challenge. Response содержит `iss` и сохраняет `state` клиента.
- Access token: 10 минут, refresh token: 7 дней; фактический доступ дополнительно
  ограничен временем жизни сессии HearthPulse. Refresh rotates, старые access
  tokens удаляются; повторное использование refresh/code отзывает семейство.
- При каждом HTTP-запросе MCP и при обновлении токена снова проверяется
  HearthPulse. Удаление роли даёт 403, недействительная сессия/токен — 401,
  ошибка проверки — 503. Ошибка проверки не открывает доступ.
- Код/токены в SQLite хешированы SHA-256. Cookie, необходимая для повторной
  проверки сессии, зашифрована AES-256-GCM отдельным 32-byte ключом из env.
- Revocation принимает только токен указанного клиента и отзывает его grant.

Authorization metadata публична; данные индекса, состояние источников и все tools
находятся за OAuth. Telegram ingress использует отдельный длинный секрет и
allowlist числовых channel IDs. Login пользователя не заменяется bot-токеном.

## Защита данных и источников

Сервер связывает токен с собственным resource URL. Секреты источников не возвращаются
в tools. Koloda token имеет только `database:read`; WordPress credentials берутся
из env; бот сохраняет свой существующий обработчик updates. Все HTTP fetches имеют
timeout, предел ответа и запрет редиректов. Пользователь не задаёт произвольный URL
или GraphQL/SQL-операцию: пути/операции выбираются кодом, identifiers проверяются,
filter values экранируются, локальный SQL параметризован.

HTML не исполняется, scripts/forms исключаются из текста. VIP unlock codes не
попадают в индекс. Boosty post-sales analytics фильтрует buyers/transactions,
сохраняя агрегаты постов и продаж. Конфигурационные ошибки и upstream secrets не
выводятся в ответы. HTTP body, выдача tools и crawl batches ограничены; Host/Origin
и rate limits защищают transport и OAuth endpoints.

Процесс должен работать отдельным Unix-пользователем. SQLite/WAL содержат приватные
статьи: каталогу нужны права 0700, файлам 0600. Программа задаёт umask 0077. Backup
содержит и базу, и encryption key; храните их защищённо и отдельно от Git.
При смене encryption key существующие grants перестают расшифровываться; пользователи
должны подключиться заново. Смена ключа не является прозрачной ротацией.

Проверки: unauthenticated/non-admin/blocked predicate, role removal, expired/revoked
tokens, fail-closed identity, PKCE, callback/resource binding, code replay, refresh
rotation/replay, consent CSRF, credential encryption, upstream error redaction.
