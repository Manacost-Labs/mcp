#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const clients = process.argv.slice(2);
// Codex starts browser OAuth during `mcp add`; configure Claude first.
const supported = ['claude', 'codex'];
const dryRun = clients.includes('--dry-run');
const selected = clients.filter(arg => arg !== '--dry-run');
if (selected.some(client => !supported.includes(client) && client !== 'all')) {
  console.error('Usage: npm run connect -- [codex|claude|all] [--dry-run]');
  process.exit(1);
}
const targets = !selected.length || selected.includes('all') ? supported : [...new Set(selected)];
const name = 'manacost';
const url = 'https://hearthpulse.net/mcp';
for (const client of targets) {
  const args = client === 'codex'
    ? ['mcp', 'add', name, '--url', url]
    : ['mcp', 'add', '--scope', 'user', '--transport', 'http', name, url];
  if (dryRun) { console.log([client, ...args].join(' ')); continue; }
  // Capture config inspection privately: existing headers/env can contain credentials.
  const existing = spawnSync(client, ['mcp', 'get', name], { encoding: 'utf8' });
  if (existing.error?.code === 'ENOENT') { console.error(`${client}: CLI is not installed.`); process.exitCode = 1; continue; }
  if (existing.status === 0) {
    const configuredUrl = /^\s*url:\s*(\S+)\s*$/im.exec(existing.stdout)?.[1];
    if (configuredUrl === url) console.log(`${client}: Manacost is already configured.`);
    else { console.error(`${client}: '${name}' already exists with another URL; existing configuration preserved.`); process.exitCode = 1; }
    continue;
  }
  const result = spawnSync(client, args, { stdio: 'inherit' });
  if (result.status !== 0) { process.exitCode = 1; continue; }
  console.log(`${client}: configured. ${client === 'codex' ? 'Authenticate with: codex mcp login manacost' : 'Open Claude Code, run /mcp and authenticate Manacost.'}`);
}
