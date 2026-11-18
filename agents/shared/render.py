#!/usr/bin/env python3
"""Render only non-secret Agent deployment settings."""
import argparse
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

AGENTS = Path(__file__).resolve().parents[1]
ROLES = ("sam", "stacy", "tyler")
SITE_KEYS = {
    "agents", "honcho_url", "honcho_workspace", "honcho_owner_peer", "quantself_url",
}
AGENT_KEYS = {"api_host", "api_port", "cdp_port", "websockify_port", "hq_mcp_url"}
TOKEN = re.compile(r"@([a-z_]+)@")


def validate_url(site, name, schemes, *, path_allowed=True):
    value = site[name]
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9.:/_~%\[\]-]+", value):
        raise ValueError(f"{name} must be a URL without credentials or query parameters")
    parsed = urlsplit(value)
    if (parsed.scheme not in schemes or not parsed.hostname
            or (parsed.port is not None and not 1 <= parsed.port <= 65535)
            or (not path_allowed and parsed.path not in ("", "/"))):
        raise ValueError(f"Invalid {name}")


def validate_agent(site):
    if not isinstance(site, dict) or set(site) != AGENT_KEYS:
        raise ValueError("Use the exact per-Agent fields from site.example.json")
    try:
        api_host = ipaddress.IPv4Address(site["api_host"])
    except ipaddress.AddressValueError:
        raise ValueError("api_host must be a Tailscale IPv4 address") from None
    if not isinstance(site["api_host"], str) or api_host not in ipaddress.IPv4Network("100.64.0.0/10"):
        raise ValueError("api_host must be a Tailscale IPv4 address")
    ports = ("api_port", "cdp_port", "websockify_port")
    for name in ports:
        if type(site[name]) is not int or not 1024 <= site[name] <= 65535:
            raise ValueError(f"{name} must be an unprivileged TCP port")
    if len({site[name] for name in ports}) != len(ports) or site["cdp_port"] == 5900:
        raise ValueError("Use distinct service ports and keep CDP off the local VNC port 5900")
    validate_url(site, "hq_mcp_url", {"http", "https"})


def site_values(role, site, account_home):
    if not isinstance(site, dict) or set(site) != SITE_KEYS:
        raise ValueError("Use the exact fleet fields from site.example.json")
    agents = site["agents"]
    if not isinstance(agents, dict) or agents.keys() - ROLES:
        raise ValueError("Use Agent names sam, stacy and tyler in the fleet file")
    if role not in agents:
        raise ValueError(f"Provide settings for {role} in the fleet file")
    for settings in agents.values():
        validate_agent(settings)
    if len({settings["api_host"] for settings in agents.values()}) != len(agents):
        raise ValueError("Each Agent needs a distinct Tailscale address")
    validate_url(site, "honcho_url", {"https"})
    validate_url(site, "quantself_url", {"https"}, path_allowed=False)
    for name in ("honcho_workspace", "honcho_owner_peer"):
        if not isinstance(site[name], str) or not re.fullmatch(r"[A-Za-z0-9_-]+", site[name]):
            raise ValueError(f"{name} must be a simple Honcho ID")
    if not re.fullmatch(r"(?:/[A-Za-z0-9_.-]+)+", account_home) or any(
        part in (".", "..") for part in account_home.split("/")
    ):
        raise ValueError("The hermes account needs a simple absolute home path")
    agent = agents[role]
    return {
        **{key: site[key] for key in SITE_KEYS - {"agents"}},
        **agent,
        "profile": f"{account_home}/.hermes",
        "workspace": f"{account_home}/workspace",
        "brain_dir": f"{account_home}/dev/brain",
        "cdp_url": f"http://{agent['api_host']}:{agent['cdp_port']}",
        "jobs_mail_toolset": "\n    - quantself_jobs_mail" if role == "sam" else "",
        "jobs_mail_plugin": ", quantself-jobs-mail" if role == "sam" else "",
        "jobs_mail_bind": (
            "\nBindReadOnlyPaths=/etc/hermes/plugins/quantself-jobs-mail:"
            f"{account_home}/.hermes/plugins/quantself-jobs-mail"
        ) if role == "sam" else "",
    }


RAW_TEMPLATE_FIELDS = {"jobs_mail_toolset", "jobs_mail_plugin", "jobs_mail_bind"}


def substitute(template, values, *, quoted=False):
    return TOKEN.sub(
        lambda match: json.dumps(values[match[1]]) if quoted and match[1] not in RAW_TEMPLATE_FIELDS else str(values[match[1]]),
        template.read_text(),
    )


def render(role, site, account_home, output):
    values = site_values(role, site, account_home)
    shared = AGENTS / "shared"
    profile = AGENTS / role
    # Hermes v0.23.1 reads secrets and selects plugin dependencies before Managed Scope.
    bootstrap = (shared / "secrets.yaml").read_text() + "\n" + (shared / "memory.yaml").read_text()
    early_profile = bootstrap
    if role == "sam":
        early_profile += "\nplugins:\n  enabled: [honcho, quantself-vaultwarden, quantself-jobs-mail]\n"
    files = {
        "config.yaml": substitute(shared / "managed.yaml", values, quoted=True) + "\n"
        + bootstrap + "\n" + substitute(profile / "config.yaml.in", values, quoted=True),
        ".env": substitute(shared / "managed.env.in", values),
        "agent-profile.yaml": early_profile,
        "honcho.json": substitute(profile / "honcho.json.in", values, quoted=True),
        "hermes-gateway.service": substitute(shared / "hermes-gateway.service.in", values),
        "hermes-screen.service": substitute(shared / "hermes-screen.service.in", values),
        "api-host": values["api_host"] + "\n",
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (output / name).write_text(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=ROLES)
    parser.add_argument("settings", type=Path)
    parser.add_argument("account_home")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        site = json.loads(args.settings.read_text())
        render(args.role, site, args.account_home, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot render Hermes config: {error}\n")


if __name__ == "__main__":
    main()
