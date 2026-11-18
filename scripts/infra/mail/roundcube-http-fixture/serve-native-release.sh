#!/bin/sh
set -eu
case "${1:-}" in
witness)
    runuser -u www-data -- php /native-fixture/native-runtime-proof.php witness \
        < /cutover-check/session-id > /cutover-check/witness.json
    exit
    ;;
prior|candidate|retained)
    runuser -u www-data -- php /native-fixture/native-runtime-proof.php "$1" < /cutover-check/witness.json
    exit
    ;;
candidate-only-schema)
    runuser -u www-data -- php /native-fixture/native-runtime-proof.php "$1"
    exit
    ;;
final-snapshot)
    # Both web workers are stopped and this volume belongs to the disposable candidate.
    runuser -u www-data -- php /native-fixture/native-runtime-proof.php final
    exit
    ;;
snapshot)
    install -d -m 0700 -o www-data -g www-data /candidate-runtime
    # Keep SQLite's WAL locking available to the snapshot process. The candidate
    # server only mounts the resulting clone.
    runuser -u www-data -- php -r '$db = new PDO("sqlite:/native-runtime/roundcube.sqlite");
        $db->setAttribute(PDO::ATTR_TIMEOUT, 5);
        if ((int) $db->query("SELECT COUNT(*) FROM users")->fetchColumn() !== 1) {
            throw new RuntimeException("Expected the previous release to have provisioned the fixture user");
        }
        $db->exec("VACUUM INTO " . $db->quote("/candidate-runtime/roundcube.sqlite"));'
    exit
    ;;
esac
release=${QS_ROUNDCUBE_FIXTURE_RELEASE:?}
if [ "$release" != "${QS_ROUNDCUBE_FIXTURE_NATIVE_PRIOR:?}" ] && [ "$release" != "${QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE:?}" ]; then
    exit 2
fi
root="/native-releases/$release"
runtime=/native-runtime
install -d -m 0700 -o www-data -g www-data "$runtime" /tmp/quantself-original
actual=$(php -r 'require $argv[1] . "/program/include/iniset.php"; echo RCMAIL_VERSION;' "$root")
test "$actual" = "$release"
if [ "$release" = "$QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE" ]; then
    test -s "$runtime/roundcube.sqlite"
fi
runuser -u www-data -- php "$root/bin/initdb.sh" --dir "$root/SQL" --update
runuser -u www-data -- php -r '$db = new PDO("sqlite:" . $argv[1]);
    if ($db->query("PRAGMA quick_check")->fetchColumn() !== "ok") {
        throw new RuntimeException("Runtime database failed SQLite quick_check");
    }' "$runtime/roundcube.sqlite"
a2enmod headers >/dev/null
cat > /etc/apache2/sites-available/000-default.conf <<EOF
<VirtualHost *:80>
    DocumentRoot "$root/public_html"
    <Directory "$root/public_html">
        Require all granted
        AllowOverride None
        Options -Indexes
        php_admin_flag display_errors Off
        <Files "installer.php">
            Require all denied
        </Files>
    </Directory>
    Header always set X-Fixture-Roundcube-Release "$actual"
</VirtualHost>
EOF
exec apache2-foreground
