# Changelog

## 1.2.1

- Correct HearthPulse browser login link to `/?login` instead of the missing
  `/profile/` route; allow queries only in the configured login URL while
  preserving the same-origin requirement and source URL restrictions.
- Regression coverage for the anonymous login page, OAuth continuation and
  login/source URL boundaries.

## 1.2.0

- Live Plausible Stats API v2 integration for configured team sites: traffic,
  pages, referrers, UTM, geography, devices, time series and tracked goals.
- Read-only statistics key, fixed endpoint, site allowlist, bounded queries,
  pagination and preserved upstream metadata/warnings; no event/settings writes.
- OAuth MCP integration and adapter coverage for statistics, invalid sites,
  malformed responses and missing credentials.

## 1.1.0

- Production systemd deployment and independent HTTPS origin/edge routes.
- One-command setup for Codex and Claude Code; configuration guides for Cursor,
  VS Code/Copilot, Gemini CLI, ChatGPT and Claude Desktop.
- Private WordPress reader for raw paid articles when service-account Application
  Passwords are disabled; avoids frontend rendering and rejects writes/drafts.
- Read-only legacy guide archive, progressive public Telegram history, rotated
  Boosty access-token bridge and accurate paid preview/Draft.js parsing.
- Real-source fixes for null Boosty titles, empty WordPress titles and bounded
  WordPress pagination; adapter/read-only bridge regression coverage.

## 1.0.0

- Admin-only remote MCP with browser login through HearthPulse, PKCE, live role
  checks, encrypted session persistence, token rotation and revocation.
- Read-only access to all Koloda API-permitted collections and large fields.
- Website content/marketing index, taxonomy/sitemap pagination and full Koloda
  paid bodies from WordPress raw shortcodes and Gutenberg blocks.
- Telegram forwarding/import, Boosty posts/local aggregate analytics, VK reads.
- Fixture-based auth/source tests and a real HTTP handshake with the official
  MCP client; deployment examples and source readiness documentation.
