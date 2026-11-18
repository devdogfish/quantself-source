"""Prepare private Compose or firewall bundles in a new local staging directory.

Run from the repository root with Python 3 on macOS or Linux:

  python3 scripts/infra/keep-storage/prepare-compose-bundles.py
    --repo-root .
    --input /private/path/endpoints.json
    --staging-parent /private/path/to/existing-directory

Use one command line. The input is an owner-only JSON file kept outside Git.
Example with synthetic endpoints:

  {
    "KEEP_BETTER_AUTH_URL": "https://app.example.invalid",
    "KEEP_BETTER_AUTH_RP_ID": "app.example.invalid",
    "KEEP_OPENCLOUD_URL": "https://files.example.invalid"
  }

Supply the exact existing origins and RP ID for a real staging run. The
command prints the staging path containing both bundles and their static
files. Use --templates-dir instead for Compose files only. This command
does not run Docker or install either bundle.
"""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from urllib.parse import urlsplit

FIELDS = {
    "app": {
        ("x-auth", "BETTER_AUTH_URL"): "KEEP_BETTER_AUTH_URL",
        ("x-auth", "BETTER_AUTH_RP_ID"): "KEEP_BETTER_AUTH_RP_ID",
        ("services", "api", "environment", "QUANTSELF_OPENCLOUD_URL"): "KEEP_OPENCLOUD_URL",
    },
    "vault": {("services", "opencloud", "environment", "OC_URL"): "KEEP_OPENCLOUD_URL"},
}
BUNDLE_TEMPLATES = Path("scripts/infra/keep-storage")
STATIC_FILES = {
    "app": {
        "Caddyfile": Path("Caddyfile"),
        "env.example": BUNDLE_TEMPLATES / "app.env.example",
    },
    "vault": {"vault.Caddyfile": BUNDLE_TEMPLATES / "vault.Caddyfile"},
}
FIREWALL_ROLES = {
    "gateway": (Path("deploy/gateway/gate-firewall.nft"), "GATE_PEER_IPV4"),
    "guest": (BUNDLE_TEMPLATES / "guest-firewall.nft", "KEEP_GUEST_DNS_IPV4"),
}
INPUT_KEYS = frozenset(name for fields in FIELDS.values() for name in fields.values())
DNS_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
DNS_HOST = rf"{DNS_LABEL}(?:\.{DNS_LABEL})*"
HTTPS_ORIGIN = rf"https://{DNS_HOST}(?::[0-9]{{1,5}})?/?"
MAPPING = re.compile(r"^( *)([\w.-]+):")


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON input key")
    return result


def load_private_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise ValueError("Private input file is required") from None
    with os.fdopen(fd, encoding="utf-8") as file:
        metadata = os.fstat(file.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            raise ValueError("Private input must be an owner-only regular file")
        try:
            values = json.load(file, object_pairs_hook=unique_object)
        except json.JSONDecodeError:
            raise ValueError("Private input must be a JSON object") from None

    return values


def load_private_input(path):
    values = load_private_json(path)
    if not isinstance(values, dict) or set(values) - INPUT_KEYS:
        raise ValueError("Private input must contain only the documented endpoint keys")
    for key in sorted(INPUT_KEYS):
        value = values.get(key)
        is_host = key == "KEEP_BETTER_AUTH_RP_ID"
        kind = "a DNS hostname" if is_host else "an HTTPS origin"
        if not isinstance(value, str) or not re.fullmatch(DNS_HOST if is_host else HTTPS_ORIGIN, value):
            raise ValueError(f"{key} requires {kind}")
        if not is_host:
            try:
                port = urlsplit(value).port
            except ValueError:
                port = 0
            if port == 0:
                raise ValueError(f"{key} requires a valid HTTPS port")
    return values


def render_template(template, fields, values):
    # The reviewed templates use block mappings with two spaces per level.
    ancestors = []
    found = set()
    rendered = []
    target_names = {path[-1] for path in fields}
    for line in template.splitlines(keepends=True):
        match = MAPPING.match(line)
        if match:
            indent, key = match.groups()
            depth = len(indent) // 2
            del ancestors[depth:]
            ancestors.append(key)
            path = tuple(ancestors)
            if key in target_names:
                if path not in fields or len(indent) != 2 * (len(path) - 1) or path in found:
                    raise ValueError(f"Unexpected template location for {key}")
                body = line.rstrip("\r\n")
                if not body[match.end():].strip():
                    raise ValueError(f"Template must define {key} as a scalar")
                line = f"{match[0]} {json.dumps(values[fields[path]])}{line[len(body):]}"
                found.add(path)
        rendered.append(line)
    if found != fields.keys():
        raise ValueError("Template is missing a required endpoint assignment")
    return "".join(rendered)


def prepare_bundles(templates_dir, input_path, staging_parent, repo_root=None):
    values = load_private_input(input_path)
    bundles = {}
    for role, fields in FIELDS.items():
        template = (templates_dir / f"{role}.compose.yaml").read_bytes().decode("utf-8")
        files = {"compose.yaml": render_template(template, fields, values).encode("utf-8")}
        if repo_root is not None:
            files.update({name: (repo_root / source).read_bytes()
                          for name, source in STATIC_FILES[role].items()})
        bundles[role] = files
    return write_staging(bundles, staging_parent, "keep-compose-")


def prepare_firewall(repo_root, role, input_path, staging_parent):
    source, field = FIREWALL_ROLES[role]
    values = load_private_json(input_path)
    if not isinstance(values, dict) or set(values) != {field} or not isinstance(values[field], str):
        raise ValueError(f"Private {role} input must contain {field}")
    try:
        address = ipaddress.IPv4Address(values[field])
    except ipaddress.AddressValueError:
        raise ValueError(f"{field} requires one IPv4 address") from None
    if address.is_unspecified or address.is_multicast or int(address) == 2 ** 32 - 1:
        raise ValueError(f"{field} requires one unicast IPv4 address")
    template = (repo_root / source).read_bytes()
    token = f"@{field}@".encode("ascii")
    if template.count(token) != 1:
        raise ValueError(f"Expected one firewall assignment for {field}")
    rendered = template.replace(token, str(address).encode("ascii"))
    if re.search(rb"@[A-Z][A-Z0-9_]*@", rendered):
        raise ValueError("Unresolved firewall template assignment")
    return write_staging({role: {source.name: rendered}}, staging_parent, "private-firewall-")


def prepare_vault_backup_identity(input_path, staging_parent):
    from backup_guest import BackupError, validate_vault_origin

    values = load_private_input(input_path)
    try:
        origin = validate_vault_origin(values["KEEP_OPENCLOUD_URL"])
    except BackupError as error:
        raise ValueError(str(error)) from None
    identity = (json.dumps({"KEEP_OPENCLOUD_URL": origin}) + "\n").encode("utf-8")
    return write_staging({"backup": {"vault-identity.json": identity}}, staging_parent, "keep-vault-identity-")


def write_staging(bundles, staging_parent, prefix):
    staging = Path(tempfile.mkdtemp(prefix=prefix, dir=staging_parent.resolve()))
    try:
        for role, files in bundles.items():
            role_dir = staging / role
            role_dir.mkdir(mode=0o700)
            for name, content in files.items():
                fd = os.open(role_dir / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as file:
                    file.write(content)
    except BaseException:
        shutil.rmtree(staging)
        raise
    return staging


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--repo-root", type=Path, help="Prepare both offline bundles")
    source.add_argument("--templates-dir", type=Path, help="Render Compose files only")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--firewall-role", choices=FIREWALL_ROLES, help="Stage one firewall file with --repo-root")
    mode.add_argument("--vault-backup-identity", action="store_true", help="Stage the backup Vault identity with --repo-root")
    parser.add_argument("--input", type=Path, required=True, help="Owner-only endpoint JSON")
    parser.add_argument("--staging-parent", type=Path, required=True, help="Existing staging directory")
    args = parser.parse_args()
    try:
        if args.firewall_role:
            if not args.repo_root:
                parser.error("--firewall-role requires --repo-root")
            print(prepare_firewall(args.repo_root, args.firewall_role, args.input, args.staging_parent))
        elif args.vault_backup_identity:
            if not args.repo_root:
                parser.error("--vault-backup-identity requires --repo-root")
            print(prepare_vault_backup_identity(args.input, args.staging_parent))
        else:
            templates_dir = args.repo_root / BUNDLE_TEMPLATES if args.repo_root else args.templates_dir
            print(prepare_bundles(templates_dir, args.input, args.staging_parent, args.repo_root))
    except UnicodeError:
        parser.exit(1, "Could not decode input or template as UTF-8\n")
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    except OSError:
        parser.exit(1, "Could not read input or templates, or write private bundles\n")


if __name__ == "__main__":
    main()
