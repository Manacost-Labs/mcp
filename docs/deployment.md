# Запуск и откат

## Подготовка

Публикация в GitHub не запускает production deployment. Рабочий endpoint появится
после установки сервиса и явного подключения Nginx к существующему HearthPulse.

1. Установите проверенную ревизию в `/opt/manacost-mcp`, Node.js 22 и зависимости
   через `npm ci`, выполните `npm run check`.
2. Создайте отдельного пользователя `manacost-mcp`, каталог `/var/lib/manacost-mcp`
   (owner service user, mode 0700), `/etc/manacost-mcp` (root, mode 0700).
3. Скопируйте `.env.example` в `/etc/manacost-mcp/mcp.env` (root, mode 0600),
   настройте key/источники, `DATABASE_PATH=/var/lib/manacost-mcp/mcp.sqlite`.
   При ограничениях публичного WAF можно указать `HEARTHPULSE_INTERNAL_URL`
   и `KOLODA_URL` на существующие loopback origins: browser login и PUBLIC_URL
   остаются на публичном origin HearthPulse. Не открывайте внутренние ports наружу.
4. Установите и проверьте systemd unit из `deploy/`. Он использует EnvironmentFile,
   поэтому не запускает npm script, требующий `.env` в рабочем каталоге.
5. Добавьте только locations из `deploy/nginx.conf` в существующий HTTPS server
   HearthPulse, проверьте `nginx -t` перед reload.

Docker-альтернатива: `docker compose build` и `docker compose up -d` после настройки
локальной `.env`. Compose использует host networking (Linux), bind 127.0.0.1 и
отдельный persistent volume. Это необходимо для existing loopback Boosty API.
Не подключайте existing database/session volumes сайтов к MCP-контейнеру.

## Проверка после запуска

- `/mcp/health` и два well-known metadata URL отвечают; authorization endpoint
  указан на том же origin.
- `POST /mcp` без token возвращает 401 с discovery challenge.
- Обычный пользователь не может получить grant; admin может подтвердить consent.
- Официальный MCP client проходит handshake и `get_source_status`.
- Полный платный материал Koloda через `get_wordpress_content` содержит body,
  а не приглашение оформить подписку; metadata.access=full.
- `list_collections`/`read_records` работают с database:read; роли upstream не
  расширяются до admin ради обхода ошибки.
- Снятие admin или logout HearthPulse закрывает следующий запрос.
- Source coverage контролируется по состояниям WordPress, sitemap, HTML, social;
  не объявляйте начальный частичный индекс всем архивом.
- Для Telegram настройте существующую очередь forwarding и проверьте реальное
  channel_post/edit, не переключая webhook.
- Live Boosty catalogue/VK проверяются отдельными read-only запросами после
  конфигурации доступа; fixtures не доказывают доступность внешнего сервиса.

Сервис не логирует bodies, OAuth query strings, source tokens или cookies. В Nginx
для OAuth routes отключён access log, чтобы code/state не попадали в общий журнал.
Мониторьте health и source status. Health показывает процесс, не полноту источников.

## Откат

Остановите только `manacost-mcp`/его compose service и удалите добавленные Nginx
locations после `nginx -t`. Existing HearthPulse, WordPress, Telegram и Boosty
продолжают работать. Не удаляйте database volume: в нём grants и приватный индекс.
Для возврата к предыдущей версии используйте сохранённую ревизию и защищённый
backup SQLite + encryption key; миграции v1 создают только собственные таблицы.
