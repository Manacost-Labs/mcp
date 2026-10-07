#!/usr/bin/env python3
"""Install the MCP include into an existing HearthPulse edge, with rollback."""
from pathlib import Path
import shutil
import subprocess
import sys

config = Path(sys.argv[1]).resolve()
original = config.read_text()
include = '    include /etc/nginx/snippets/manacost-mcp-edge.conf;'
if include not in original:
    marker = '    ssl_certificate /etc/nginx/ssl/hearthpulse.net/fullchain.pem;'
    if marker not in original:
        raise SystemExit('Unexpected edge configuration; preserved.')
    backups = Path('/etc/nginx/manacost-mcp-backups')
    backups.mkdir(mode=0o700, exist_ok=True)
    backup = backups / config.name
    if not backup.exists():
        shutil.copy2(config, backup)
        backup.chmod(0o600)
    config.write_text(original.replace(marker, include + '\n' + marker, 1))
    try:
        subprocess.run(['/usr/sbin/nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except subprocess.CalledProcessError:
        config.write_text(original)
        subprocess.run(['/usr/sbin/nginx', '-t'], check=True)
        raise SystemExit('Edge configuration restored after failed validation.') from None
print('MCP edge route installed and Nginx validated.')
