# Подключение агентов

Адрес сервера: **https://hearthpulse.net/mcp**. Transport: **Streamable HTTP**.
Авторизация: OAuth 2.1 с PKCE, вход через HearthPulse, только текущий admin.
Ключи WordPress, базы и соцсетей клиентам не нужны. Каждый клиент получает
собственный grant. При logout HearthPulse или снятии admin доступ закрывается.

Форма входа HearthPulse: **https://hearthpulse.net/?login**. Маршрут `/profile/`
не существует. Если ещё не вошли, нажмите «Войти на HearthPulse» на странице MCP,
войдите под администратором в том же браузере, вернитесь во вкладку MCP и нажмите
«Продолжить после входа», затем подтвердите доступ. Для новой попытки в Codex CLI:
`codex mcp login manacost` (имя должно совпадать с вашей настройкой сервера).

## Codex и Claude Code — одна команда

На машине, где установлен клиент, из checkout этого репозитория:

```sh
npm run connect
```

Node.js нужен только для установщика; установка npm-зависимостей сервера не нужна.
Команда сначала добавляет Manacost в Claude Code, затем в Codex. Codex при первом
добавлении запускает браузерный OAuth. Команда использует пользовательские конфигурации,
сохраняет другие MCP и не заменяет одноимённый сервер с другим адресом.
Можно выбрать `npm run connect -- codex` или `npm run connect -- claude`.
Предварительный просмотр: `npm run connect -- all --dry-run`.

### Codex CLI / Desktop / IDE

```sh
codex mcp add manacost --url https://hearthpulse.net/mcp
codex mcp login manacost
```

В браузере войдите в HearthPulse администратором, вернитесь на страницу подключения
и подтвердите доступ. Desktop и IDE используют локальную конфигурацию Codex;
перезапустите клиент после добавления. Конфигурация не переносится автоматически
между сервером и вашим компьютером — выполните команду на каждой нужной машине.

### Claude Code

```sh
claude mcp add --scope user --transport http manacost https://hearthpulse.net/mcp
```

Запустите Claude Code → `/mcp` → Manacost → Authenticate. В браузере войдите
администратором HearthPulse и подтвердите доступ. Конфигурация пользовательская,
поэтому сервер доступен во всех проектах этой машины.

## Остальные клиенты

- **Cursor:** Settings → MCP → добавьте `{"mcpServers":{"manacost":{"url":"https://hearthpulse.net/mcp"}}}` к существующему JSON. Нажмите Connect/Authenticate.
- **VS Code / Copilot:** добавьте в `.vscode/mcp.json` `{"servers":{"manacost":{"type":"http","url":"https://hearthpulse.net/mcp"}}}`. При первом запуске подтвердите доверие и OAuth.
- **Gemini CLI:** добавьте в `~/.gemini/settings.json` `{"mcpServers":{"manacost":{"httpUrl":"https://hearthpulse.net/mcp"}}}`. Авторизуйте сервер через `/mcp auth manacost`.
- **ChatGPT:** включите Developer mode в настройках Apps, создайте custom app с адресом MCP и OAuth (scope `mcp.read`), подключите аккаунт HearthPulse. Доступность зависит от плана и политики workspace; клиент может запросить повторную авторизацию, если его политика требует `offline_access` для фонового обновления.
- **Claude Desktop:** добавьте remote connector с этим адресом через Settings → Connectors; войдите через HearthPulse. Возможность зависит от плана клиента.

Объединяйте примеры с существующими конфигурациями; не заменяйте весь файл.

## Проверка

Попросите агента: «Вызови get_source_status в Manacost и покажи покрытие источников».
Для маркетинга: «Сравни темы и навигацию HearthPulse, Manacost и Koloda; найди
платные статьи, которые можно продвигать, и укажи ссылки и ограничения данных».
Для базы: `list_collections` → `describe_collection` → `read_records` с выбранными
полями и пагинацией. Архив может индексироваться постепенно; отсутствие страницы
в поиске не доказывает отсутствие материала на сайте.

Если браузер запущен на другом компьютере, используйте `codex mcp login manacost
--no-browser` и инструкции CLI для передачи callback. Не передавайте cookie или
токен другому человеку. Удаление локального подключения не отзывает grant:
отзовите OAuth grant или выйдите из HearthPulse, если требуется закрыть доступ.

Официальные справки: [Claude Code](https://code.claude.com/docs/en/mcp),
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/),
[ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).
Команды Codex проверены через `codex mcp add --help` и живой OAuth discovery.
