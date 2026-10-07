#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/hearthpulse.net ]; then
    /usr/sbin/nginx -t
    /bin/systemctl reload nginx
fi
