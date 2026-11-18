#!/bin/sh
set -eu
install -d -m 0755 plugins/quantself_original
install -m 0644 /stage/plugins/quantself_original/*.php plugins/quantself_original/
install -d -m 0700 -o www-data -g www-data /tmp/quantself-original
if [ "${QS_ROUNDCUBE_FIXTURE_PACKAGE:-}" = mixed-case-account ]; then
    php <<'PHP'
<?php
$db = new PDO('sqlite:/var/roundcube/db/sqlite.db');
$db->exec("INSERT INTO users (username, mail_host) VALUES ('Jobs@example.test', 'imap-fixture')");
PHP
fi
