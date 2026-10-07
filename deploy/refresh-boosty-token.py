#!/usr/bin/env python3
"""Copy only the current access token; leave the upstream session untouched."""
import argparse
import grp
import json
import os
from pathlib import Path
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--target', required=True, type=Path)
args = parser.parse_args()
try:
    if args.source.stat().st_size > 65536:
        raise ValueError('oversized session')
    session = json.loads(args.source.read_text())
    token = session.get('access_token')
    if not isinstance(token, str) or not token or len(token) > 16384 or any(c in token for c in '\r\n'):
        raise ValueError('invalid access token')
    if args.target.exists() and args.target.read_text() == token:
        raise SystemExit(0)
    with tempfile.NamedTemporaryFile(mode='w', dir=args.target.parent, delete=False) as staged:
        staged_path = Path(staged.name)
        os.fchmod(staged.fileno(), 0o640)
        os.fchown(staged.fileno(), 0, grp.getgrnam('manacost-mcp').gr_gid)
        staged.write(token)
        staged.flush()
        os.fsync(staged.fileno())
    os.replace(staged_path, args.target)
except SystemExit:
    raise
except Exception:
    # Upstream response/storage can contain credentials; never log the exception.
    raise SystemExit('Boosty access-token bridge failed; private session preserved.') from None
