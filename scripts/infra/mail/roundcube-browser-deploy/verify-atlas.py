#!/usr/bin/env python3
"""Qualify the exact staged unit and loopback browser in disposable Linux."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from time import monotonic, time

HERE = Path(__file__).resolve().parent
IMAGE = "docker.io/roundcube/roundcubemail@sha256:37a90cb245228080779462fd120db3d64335e1abbec33bda94ca18c9e163881b"
SYSTEMD_IMAGE = "quantself-atlas-ssh-proof:debian13"
HOST = "atlas-browser.fixture.ts.net"
AUTHORITY = HOST + ":18445"
SCRIPT = r"""
set -eu
root=/opt/quantself-roundcube/browser
apache2 -t -f "$root/apache.conf"
if "$root/check-credential-mount.sh"; then exit 7; fi
"$root/prepare-runtime.sh"
apache2 -f "$root/apache.conf" -DFOREGROUND &
apache_pid=$!
php /fixture/verify-front-door.php &
relay_pid=$!
trap 'kill "$apache_pid" "$relay_pid" 2>/dev/null || true' EXIT
loopback=http://127.0.0.1:18080
origin=https://atlas-browser.fixture.ts.net:18445
resolve=atlas-browser.fixture.ts.net:18445:127.0.0.1
curl_tunnel() {
    curl --noproxy '*' --max-time 3 --resolve "$resolve" --cacert /fixture/front-door.crt "$@"
}
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl_tunnel -fsS -D /tmp/response -o /tmp/login "$origin/" 2>/dev/null; then break; fi
    sleep .2
done
grep -qi '^Set-Cookie: qs_atlas_roundcube=.*secure.*httponly.*samesite=lax' /tmp/response
grep -q 'name="_user"' /tmp/login
ref=$(cat /fixture/reference)
curl_tunnel -fsS -o /tmp/signed-login "$origin/?_task=mail&_action=show&_ref=$ref"
grep -Fq "$ref" /tmp/signed-login
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' "$origin/?_task=mail&_action=show&_ref=forged")" = 409
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' "$origin/static.php/skins/elastic/styles/styles.min.css")" = 200
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' "$origin/installer.php")" = 403
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' "$origin/config/config.inc.php")" = 404
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' -H 'Host: other.fixture.ts.net:18445' "$origin/")" = 403
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' -H 'Host: atlas-browser.fixture.ts.net' "$origin/")" = 403
test "$(curl_tunnel -sS -o /dev/null -w '%{http_code}' -H 'X-Fixture-Funnel: yes' "$origin/")" = 403
test "$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: atlas-browser.fixture.ts.net:18445' "$loopback/")" = 403
if curl --noproxy '*' --silent --resolve "$resolve" --max-time 3 -o /dev/null "$origin/"; then exit 8; fi
php -r '
require "/opt/quantself-roundcube/browser/release/config/config.inc.php";
$db = new PDO($config["db_dsnw"]);
if ($db->query("PRAGMA quick_check")->fetchColumn() !== "ok" ||
    $config["quantself_original"]["audience"] !== "atlas-browser.fixture.ts.net" ||
    $config["quantself_original_mailbox"]["account"] !== "jobs@example.test" ||
    $config["imap_conn_options"]["ssl"]["verify_peer_name"] !== true ||
    $config["imap_cache"] !== null || $config["messages_cache"] !== false ||
    $config["disabled_actions"] !== ["mail.send"]) exit(9);
'
test "$(stat -c %a /run/quantself-roundcube/spool)" = 700
test -z "$(find /opt/quantself-roundcube/browser -name roundcube.sqlite)"
printf '%s\n' 'PASS loopback, TLS Host/port, cookies, signed login gate, public root, Funnel refusal and volatile SQLite'
"""


def run(*args, timeout=45):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]} qualification command failed ({result.returncode})")
    return result.stdout


def bind(source, target):
    return "--mount", f"type=bind,source={source},target={target},readonly"


def snapshot(root):
    return {p.relative_to(root): hashlib.sha256(p.read_bytes()).digest()
            for p in root.rglob("*") if p.is_file()}


def write_reference(path, fixture):
    def encode(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=")

    now = int(time())
    claims = [HOST, "jobs@example.test", "INBOX", 42, 120, "<browser-fixture@example.test>",
              "show", None, now - 5, now + 240]
    signed = b"qs-original-v1." + encode(json.dumps(claims, separators=(",", ":")).encode())
    payload = path / "signed"
    payload.write_bytes(signed)
    signature = run("openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(path / "private.pem"),
                    "-in", str(payload))
    (fixture / "reference").write_bytes(signed + b"." + encode(signature))


def verify(assets):
    started = monotonic()
    with tempfile.TemporaryDirectory(prefix="roundcube-browser-proof-") as tmp:
        path = Path(tmp)
        fixture = path / "fixture"
        fixture.mkdir()
        site = path / "site.json"
        site.write_text(json.dumps({
            "version": "1.7.6", "origin": "https://" + AUTHORITY, "loopback_port": 18080,
            "sibling_hosts": ["atlas-apps.fixture.ts.net"],
            "imap_host": "imap-fixture.example.test", "mailbox": "jobs@example.test",
        }))
        key = path / "public.pem"
        run("openssl", "genpkey", "-algorithm", "ED25519", "-out", str(path / "private.pem"))
        run("openssl", "pkey", "-in", str(path / "private.pem"), "-pubout", "-out", str(key))
        write_reference(path, fixture)
        cert = fixture / "front-door.crt"
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=" + HOST, "-addext", "subjectAltName=DNS:" + HOST,
            "-keyout", str(fixture / "front-door.key"), "-out", str(cert))
        shutil.copyfile(HERE / "verify-front-door.php", fixture / "verify-front-door.php")
        (fixture / "des-key").write_bytes(b"\x51" * 32)
        (fixture / "front-door.key").chmod(0o644)  # A disposable fixture key read by the unprivileged relay.
        stage = path / "stage"
        elapsed = monotonic()
        command = [sys.executable, "-B", str(HERE / "stage.py"), str(stage),
                   "--site", str(site), "--assets", str(assets), "--verify-key", str(key), "--imap-ca", str(cert)]
        run(*command)
        print(f"PASS signed release stage in {monotonic() - elapsed:.2f}s", flush=True)
        root = stage / "opt/quantself-roundcube/browser"
        before = snapshot(root)
        assert not any(p.name in {"des-key", "private.pem", "roundcube.sqlite"} for p in before)
        assert (root / "installed.json").read_text().strip() == '{"version": "1.7.6"}'
        plugin = root / "release/plugins/quantself_original"
        assert {f.name for f in plugin.iterdir()} == {"quantself_original.php", "verify.php", "mailbox.php", "bounded_imap.php"}
        bad_site = path / "bad-site"
        bad_site.write_text(site.read_text().replace("https://", "http://"))
        shared_host = path / "shared-host"
        shared_host.write_text(site.read_text().replace(AUTHORITY, "atlas-apps.fixture.ts.net:18446"))
        bad_assets = path / "bad-assets"
        bad_assets.mkdir()
        (bad_assets / "roundcubemail-1.7.6-complete.tar.gz").write_bytes(b"corrupt")
        controls = ((None, None), ("--site", bad_site), ("--site", shared_host),
                    ("--assets", bad_assets), ("--verify-key", path / "private.pem"))
        for arg, value in controls:
            denied = command.copy()
            if arg:
                denied[3] = str(path / "blocked")
                denied[denied.index(arg) + 1] = str(value)
            result = subprocess.run(denied, capture_output=True, timeout=15)
            assert result.returncode == 2 and not result.stdout
            assert not (path / "blocked").exists()
        print("PASS existing stage, non-TLS origin, sibling hostname, corrupt archive and private-key refusal", flush=True)

        # The fixture image's PHP module has a different filename from Debian's native package.
        (fixture / "php8.4.load").write_text("LoadModule php_module /usr/lib/apache2/modules/libphp.so\n")
        for name, row in (("passwd", "quantself-roundcube-browser:x:33:33::/nonexistent:/usr/sbin/nologin\n"),
                          ("group", "quantself-roundcube-browser:x:33:\n")):
            data = run("docker", "run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "cat", IMAGE, "/etc/" + name)
            (fixture / name).write_bytes(data + row.encode())
        elapsed = monotonic()
        output = run("docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only",
                     "--user", "33:33", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                     "--memory", "256m", "--memory-swap", "256m",
                     "--tmpfs", "/run/quantself-roundcube:rw,nosuid,nodev,size=32m,uid=33,gid=33,mode=0700",
                     "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "-e", "CREDENTIALS_DIRECTORY=/fixture",
                     *bind(root, "/opt/quantself-roundcube/browser"), *bind(fixture, "/fixture"),
                     *bind(fixture, "/run/quantself-roundcube-inputs"),
                     *bind(fixture / "php8.4.load", "/etc/apache2/mods-available/php8.4.load"),
                     *bind(fixture / "passwd", "/etc/passwd"), *bind(fixture / "group", "/etc/group"),
                     "--entrypoint", "sh", IMAGE, "-c", SCRIPT)
        print(output.decode().strip(), f"in {monotonic() - elapsed:.2f}s", flush=True)
        run("docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only",
            "--tmpfs", "/run/quantself-roundcube-inputs:mode=0700,size=64k",
            *bind(root / "check-credential-mount.sh", "/fixture/check-credential-mount.sh"),
            "--entrypoint", "sh", IMAGE, "-ec",
            "test \"$(findmnt -n -o FSTYPE --mountpoint /run/quantself-roundcube-inputs)\" = tmpfs; "
            "! /fixture/check-credential-mount.sh")
        print("PASS persistent and swappable credential source refusal", flush=True)
        units = stage / "etc/systemd/system"
        run("docker", "run", "--rm", "--pull=never", "--network", "none",
            *bind(units, "/etc/systemd/system"), *bind(root, "/opt/quantself-roundcube/browser"),
            "--entrypoint", "sh", SYSTEMD_IMAGE, "-ec",
            "ln -s /bin/true /usr/sbin/apache2; systemd-analyze verify /etc/systemd/system/*")
        print("PASS systemd service and credential mount verification", flush=True)
        assert before == snapshot(root)
        print(f"PASS backed bundle unchanged in {monotonic() - started:.2f}s", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    args = parser.parse_args()
    verify(args.assets.resolve())


if __name__ == "__main__":
    main()
