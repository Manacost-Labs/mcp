# Production deployment

Текущая установка работает на **https://hearthpulse.net/mcp**. Git push запускает
CI, но не меняет production. Исходники — этот репозиторий; runtime —
`/opt/manacost-mcp`; индекс — `/var/lib/manacost-mcp/mcp.sqlite`; защищённые настройки
и идентификаторы созданных credentials — `/etc/manacost-mcp`.

## Сервисы

- `manacost-mcp.service`: отдельный пользователь, loopback `127.0.0.1:3100`,
  автоматический старт и последовательная синхронизация каждые пять минут.
- `manacost-mcp-wordpress.service`: локальный reader `127.0.0.1:3110`, WP-CLI под
  владельцем сайта, fixed published-content GET routes, отдельный secret.
- `manacost-mcp-boosty-token.timer`: каждые пять минут копирует текущий access token
  Boosty; существующая сессия и refresh token не меняются.
- Независимый origin vhost `deploy/nginx-origin-vhost.conf`, public certificate
  HearthPulse и `deploy/reload-certificate.sh` для reload после renewal.
- На активных региональных прокси `deploy/nginx-edge.conf` и transport snippet
  направляют только MCP/metadata к этому vhost через existing origin tunnels.
  Login и основной сайт используют прежний application origin.

OAuth access/error logs отключены на обоих уровнях. Host/SNI задаётся явно,
upstream TLS проверяется. Nginx сохраняет безопасный failover соединений и не
пересылает уже отправленные POST повторно (`non_idempotent` запрещён).

## Повторная установка

1. Node.js 22.22.2+, PHP 8.1+ и существующий WP-CLI нужны для native deployment.
   Выполните `npm ci` и `npm run check` в проверенном checkout.
2. Создайте service user `manacost-mcp`, state directory (owner service user,
   0700) и `/etc/manacost-mcp` (root:manacost-mcp, 0750). Env files — root, 0600.
3. Создайте отдельные `SESSION_ENCRYPTION_KEY`/ingress/reader secrets. Выпустите
   Koloda key только с `database:read` и HearthPulse key с `statistics.read`.
   Не копируйте административные ключи в MCP. Текущий Koloda token действует
   365 дней с момента выпуска; rotation выполняется через существующий API/CLI.
4. Создайте роль/аккаунт WordPress через `deploy/provision-wordpress.php`,
   выполнив его WP-CLI на правильном `--path`/`--url` и захватив stdout приватно.
   Существующий одноимённый аккаунт скрипт сохраняет. Для локального bridge задайте
   `WORDPRESS_ROOT` и новый `WORDPRESS_READER_PASSWORD` в отдельном
   `wordpress-reader.env`; этот secret укажите в `KOLODA_WP_PASSWORD`,
   username `manacost-mcp`, `KOLODA_WP_API_URL=http://127.0.0.1:3110`.
5. Настройте source URLs/paths, Telegram public username и при необходимости
   ingress allowlist. Для Boosty задайте token-file bridge и проверенный путь
   существующей managed session. VK подключается только после предоставления
   действующего token сообщества/приложения; сейчас он не настроен.
   Для Plausible задайте отдельный `PLAUSIBLE_API_KEY` со scope `stats:read:*`,
   `PLAUSIBLE_URL=http://127.0.0.1:8000`, публичный dashboard URL и allowlist
   `PLAUSIBLE_SITE_IDS`. [Настройка и запросы](plausible.md).
6. Установите build, production dependencies, deploy/scripts в `/opt/manacost-mcp`
   (root-owned), unit files из `deploy/`, выполните daemon-reload и enable --now.
7. Установите origin vhost/snippet и сертификатный hook. Адаптируйте listen IP,
   сертификатные пути и allowlist к серверу. На edge установите оба snippets;
   `deploy/install-edge.py CONFIG` добавляет include в HTTPS block с backup и
   восстановлением при неуспешном `nginx -t`. Всегда проверяйте перед reload.
8. Выполните проверки ниже; затем установите клиент по [clients.md](clients.md).

Для обновления сохраните текущий runtime/build как root-only rollback artifact,
выполните checks новой ревизии, установите build/dependencies/deploy в runtime,
перезапустите только MCP и проверьте health. Настройки и state не перезаписываются.

Docker — альтернативный запуск основного MCP, не замена native source bridges.
Host networking нужен для loopback APIs. Если используете token file/legacy
archive, разрешите чтение только конкретных файлов read-only и согласуйте UID/GID;
не монтируйте целые WordPress directories или session volumes.

## Проверки и наблюдение

- Health отвечает 200, discovery содержит issuer/resource `https://hearthpulse.net/mcp`;
  POST без token отвечает 401 с OAuth challenge на каждом активном edge.
- Admin в браузере подтверждает grant; guest/non-admin не получает доступ.
  Logout/снятие admin закрывает следующий запрос. Проверка live identity выполняется
  на loopback API существующего HearthPulse, cookies не переносятся в клиент.
- Официальный MCP client проходит handshake после пользовательского OAuth.
  `get_source_status` показывает coverage/errors. Fixtures проверяют auth flow;
  реальный browser login необходимо выполнить самим владельцем клиента.
- Полная платная статья проверяется через `get_wordpress_content`, включая текст
  внутри locker. Current live smoke подтвердил body размером 12015 символов.
- Live API подтвердил database collections и HearthPulse statistics; авторизованный
  Boosty запрос вернул 20 полных постов; legacy импорт содержит 621 полный материал.
- Индексация сайтов/Telegram прогрессивная. Health подтверждает процесс, не весь
  архив. Удаления upstream не удаляют автоматически cached content.
- `systemctl is-active manacost-mcp manacost-mcp-wordpress`, статус token timer и
  `journalctl -u manacost-mcp` помогают проверить процесс без вывода secrets.

## Откат

Остановите только новые MCP/reader/token-timer units. На edge уберите MCP include
(backup в `/etc/nginx/manacost-mcp-backups`); на origin отключите собственный MCP
vhost/snippet/hook после `nginx -t`. Основные сайты и существующие боты сохраняются.
Не удаляйте индекс, env files или existing session/backup volumes.

Идентификаторы собственных новых ключей сохранены в защищённом каталоге; отзывайте
только их через существующий API/CLI. WordPress account `manacost-mcp`/его роль
созданы отдельно и не владеют контентом; удалять их следует только после остановки
reader и проверки отсутствия записей. Для возврата приложения используйте прежний
проверенный build, сохранив SQLite state и encryption key.
