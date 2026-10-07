# Changelog

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
