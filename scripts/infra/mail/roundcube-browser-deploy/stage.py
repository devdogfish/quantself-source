#!/usr/bin/env python3
"""Stage the signed Atlas browser release without contacting any service."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from roundcube_reviewed_releases import DEFAULT

INSTALL = Path("/opt/quantself-roundcube/browser")
PRIMARY = "F3E4C04BB3DB5D4215C45F7F5AB2BAA141C4F7D5"
SIGNER = "8970E37A698AF775D87D590DC2946A9609CD56B4"
DNS = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?")
ED25519_SPKI = bytes.fromhex("302a300506032b6570032100")


def read_site(path):
    site = json.loads(path.read_text())
    if not isinstance(site, dict) or set(site) != {
        "version", "origin", "sibling_hosts", "loopback_port", "imap_host", "mailbox",
    }:
        raise ValueError("invalid site fields")
    if site["version"] != DEFAULT["candidate"]["version"]:
        raise ValueError("release is outside the browser pin")
    if not all(isinstance(site[key], str) for key in ("origin", "imap_host", "mailbox")):
        raise ValueError("invalid site field type")
    origin = urlsplit(site["origin"])
    port = site["loopback_port"]
    siblings = site["sibling_hosts"]
    if (
        not isinstance(siblings, list) or not siblings
        or any(not isinstance(host, str) or not DNS.fullmatch(host) for host in siblings)
        or len(siblings) != len(set(siblings)) or origin.hostname in siblings
    ):
        raise ValueError("expected a dedicated browser hostname")
    if (
        origin.scheme != "https" or not origin.hostname or not DNS.fullmatch(origin.hostname)
        or not origin.hostname.endswith(".ts.net")
        or origin.port == 443
        or site["origin"] != f"https://{origin.hostname}" + (f":{origin.port}" if origin.port else "")
        or type(port) is not int or not 1024 <= port <= 65535 or port == (origin.port or 443)
        or not DNS.fullmatch(site["imap_host"])
    ):
        raise ValueError("invalid browser origin or endpoint")
    login, at, domain = site["mailbox"].partition("@")
    if not at or len(login) > 64 or not re.fullmatch(r"[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*", login) or not DNS.fullmatch(domain):
        raise ValueError("invalid canonical mailbox")
    return site, origin


def run(args):
    return subprocess.run(args, capture_output=True, check=True, timeout=30).stdout


def unpack_verified(assets, scratch, release):
    pin = DEFAULT["candidate"]
    name = f"roundcubemail-{pin['version']}-complete.tar.gz"
    for filename, expected in ((name, pin["archive_sha256"]), (name + ".asc", pin["signature_sha256"])):
        local = scratch / filename
        shutil.copyfile(assets / filename, local)
        with local.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise ValueError("asset checksum mismatch")
    keyring = scratch / "roundcube.gpg"
    public = assets / "pubkey.asc"
    if not public.read_bytes().startswith(b"-----BEGIN PGP PUBLIC KEY BLOCK-----"):
        raise ValueError("expected an armored OpenPGP public key")
    run(["gpg", "--no-options", "--homedir", str(scratch), "--batch", "--dearmor",
         "--output", str(keyring), str(public)])
    status = run(["gpgv", "--homedir", str(scratch), "--keyring", str(keyring), "--status-fd", "1",
                  str(scratch / (name + ".asc")), str(scratch / name)])
    valid = [line.split() for line in status.splitlines() if line.startswith(b"[GNUPG:] VALIDSIG ")]
    if len(valid) != 1 or valid[0][2] != SIGNER.encode() or valid[0][-1] != PRIMARY.encode():
        raise ValueError("release signer mismatch")
    with tarfile.open(scratch / name) as archive:
        archive.extractall(scratch, filter="data")
    upstream = scratch / f"roundcubemail-{pin['version']}"
    if not (upstream / "public_html/index.php").is_file() or (upstream / "config/config.inc.php").exists():
        raise ValueError("unexpected upstream layout")
    shutil.move(upstream, release)


def stage(output, site_path, assets, verify_key, imap_ca):
    site, origin = read_site(site_path)
    pem = re.fullmatch(rb"\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=]{60})\s+-----END PUBLIC KEY-----\s*", verify_key.read_bytes())
    if not pem:
        raise ValueError("expected a PEM public key")
    spki = base64.b64decode(pem[1], validate=True)
    if len(spki) != len(ED25519_SPKI) + 32 or not spki.startswith(ED25519_SPKI):
        raise ValueError("expected an Ed25519 public key")
    key = spki[len(ED25519_SPKI):]
    ca = imap_ca.read_bytes()
    if len(ca) > 128 * 1024 or not re.fullmatch(
        rb"(?:\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----)+\s*", ca,
    ):
        raise ValueError("invalid public verification or CA input")
    ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=ca.decode("ascii"))
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise ValueError("expected a new absolute stage directory")
    with tempfile.TemporaryDirectory(prefix=".roundcube-browser-", dir=output.parent) as temp:
        scratch = Path(temp)
        bundle = scratch / "bundle"
        bundle.mkdir(mode=0o700)
        root = bundle / INSTALL.relative_to("/")
        root.mkdir(parents=True)
        release = root / "release"
        unpack_verified(assets, scratch, release)
        plugin = scratch / "plugin"
        run(["bash", str(HERE.parent / "roundcube-original-package/stage.sh"), str(plugin)])
        shutil.copytree(plugin / "plugins/quantself_original", release / "plugins/quantself_original")
        shutil.copyfile(HERE / "config.inc.php", release / "config/config.inc.php")
        (root / "site.json").write_text(json.dumps(site) + "\n")
        (root / "installed.json").write_text(json.dumps({"version": site["version"]}) + "\n")
        (root / "original.pub").write_bytes(key)
        (root / "imap-ca.pem").write_bytes(ca)
        apache = (HERE / "apache.conf.in").read_text()
        for name, value in {"PORT": str(site["loopback_port"]), "AUTHORITY": origin.netloc}.items():
            apache = apache.replace(f"@{name}@", value)
        (root / "apache.conf").write_text(apache)
        for script in ("prepare-runtime.sh", "check-credential-mount.sh"):
            shutil.copyfile(HERE / script, root / script)
            (root / script).chmod(0o755)
        units = bundle / "etc/systemd/system"
        units.mkdir(parents=True)
        for unit in ("quantself-roundcube-browser.service", r"run-quantself\x2droundcube\x2dinputs.mount"):
            shutil.copyfile(HERE / unit, units / unit)
        output.mkdir(mode=0o700)
        for entry in bundle.iterdir():
            entry.rename(output / entry.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--site", required=True, type=Path)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--verify-key", required=True, type=Path, help="Ed25519 SubjectPublicKeyInfo PEM")
    parser.add_argument("--imap-ca", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o022)
    try:
        stage(args.output, args.site, args.assets, args.verify_key, args.imap_ca)
    except (AttributeError, OSError, ValueError, tarfile.TarError, subprocess.SubprocessError):
        parser.exit(2, "Browser staging refused. Check the site contract, public inputs, release assets and output location.\n")
    print("Staged the signed browser release, guard and systemd configuration.")


if __name__ == "__main__":
    main()
