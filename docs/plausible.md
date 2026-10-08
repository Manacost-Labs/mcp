# Plausible

Подключён существующий Plausible CE **3.2.1**, публичная панель
`https://stats.hs-manacost.ru`, локальный Stats API `http://127.0.0.1:8000`.
В Plausible зарегистрированы три сайта:

- `hs-manacost.ru`
- `kolodahearthstone.com`
- `hearthpulse.net`

Используется отдельный ключ **Manacost MCP** с единственным scope `stats:read:*`
команды, владеющей этими сайтами. Существующие ключи и пользовательские сессии
сохранены. Ключ хранится только в `/etc/manacost-mcp/mcp.env`; в Git его нет.
Для другой установки создайте отдельный Stats API key в настройках Plausible.

```dotenv
PLAUSIBLE_URL=http://127.0.0.1:8000
PLAUSIBLE_DASHBOARD_URL=https://stats.hs-manacost.ru
PLAUSIBLE_SITE_IDS=hs-manacost.ru,kolodahearthstone.com,hearthpulse.net
PLAUSIBLE_API_KEY=<отдельный ключ только в защищённой конфигурации>
```

При добавлении нового сайта в Plausible добавьте его ID в серверный allowlist и
перезапустите MCP. Список разрешённых сайтов намеренно не расширяется запросом
агента. `list_plausible_sites` показывает настройку; реальную доступность проверяет
`get_plausible_stats`. Последний результат запроса отражается в `get_source_status`.

## Примеры аргументов `get_plausible_stats`

Посещаемость за семь дней:

```json
{"siteId":"hs-manacost.ru","dateRange":"7d","metrics":["visitors","pageviews","visits","bounce_rate"]}
```

Популярные страницы:

```json
{"siteId":"kolodahearthstone.com","dateRange":"30d","metrics":["visitors","pageviews"],"dimensions":["event:page"],"limit":20}
```

Источники переходов и UTM:

```json
{"siteId":"hearthpulse.net","dateRange":"7d","dimensions":["visit:source","visit:utm_campaign"]}
```

Динамика за конкретный период:

```json
{"siteId":"hs-manacost.ru","dateRange":["2026-10-01","2026-10-07"],"dimensions":["time:day"]}
```

Настроенные цели:

```json
{"siteId":"hs-manacost.ru","dateRange":"7d","metrics":["visitors","events","conversion_rate"],"dimensions":["event:goal"]}
```

Фильтр по странице или кампании задаётся через `filters`, например
`[["is","event:page",["/guide/"]]]`. Несколько фильтров соединяются AND.
Для продолжения передайте возвращённый `nextOffset` как `offset`, сохранив остальные
аргументы. Порядок значений в каждой строке `results.metrics`/`results.dimensions`
соответствует одноимённым массивам названий в ответе. `query` содержит нормализованный
запрос Plausible и его фактический диапазон времени; `meta` сохраняет предупреждения.

## Границы

- Только фиксированный POST `/api/v2/query`, являющийся чтением статистики.
  Events API, управление сайтами, изменение целей и SQL не доступны.
- Доступ требует действующего admin grant HearthPulse, как у остальных MCP tools.
- До 100 строк за запрос, 3 измерений, 10 фильтров; произвольные custom properties
  не принимаются. Конкретный диапазон дат — не более 366 дней.
- Импортированные данные включаются только при `includeImports=true`; Plausible
  может исключить их из несовместимого запроса, что отражается в `meta`.
- Цели показывают только уже настроенные и реально отслеживаемые события.
  Запрос не создаёт отслеживание покупок и не связывает автоматически визит с
  покупателем Boosty. У старого сайта/Telegram/Boosty нет отдельных Plausible site IDs.
- Аналитика читается по запросу; сырой поток посещений не копируется в индекс MCP.

Контракт: [официальный Stats API v2](https://plausible.io/docs/stats-api).
Текущая установленная CE дополнительно проверена живыми запросами, поскольку
документация облачного Plausible может описывать более новые возможности.
