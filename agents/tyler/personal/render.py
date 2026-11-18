"""Render the separate Tyler gateway with only Bot HQ’s personal tools."""

import ipaddress
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


def render(api_host, hq_mcp_url, output):
    if ipaddress.IPv4Address(api_host) not in ipaddress.IPv4Network("100.64.0.0/10"):
        raise ValueError("The personal gateway must bind Tyler's Tailscale IPv4 address.")
    hq = urlsplit(hq_mcp_url)
    if (hq.scheme != "https" or not hq.hostname or hq.username or hq.password or hq.query or hq.fragment
            or not re.fullmatch(r"/mcp/bot_[A-Za-z0-9_-]{1,64}", hq.path)):
        raise ValueError("Provide the private Bot HQ HTTPS MCP URL for Tyler's personal record.")
    config = {
        "model": {"provider": "openai-codex", "default": "gpt-6.1-sol"},
        "fallback_providers": [],
        "platform_toolsets": {"api_server": ["hq"], "cli": ["hq"]},
        "approvals": {"mode": "smart", "cron_mode": "deny", "single_query_mode": "deny", "unattended_mode": "deny"},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "plugins": {"enabled": [], "auto_apply": False},
        "security": {"redact_secrets": True},
        "vault": {"bitwarden": {"enabled": False}, "onepassword": {"enabled": False}},
        "mcp_servers": {"hq": {"url": hq_mcp_url, "headers": {
            "Authorization": "Bearer ${PERSONAL_BOT_HQ_MCP_TOKEN}",
        }}},
    }
    output.mkdir(parents=True, exist_ok=True)
    # JSON is also valid YAML and keeps values separate from configuration syntax.
    (output / "config.yaml").write_text(json.dumps(config, indent=2) + "\n")
    (output / "gateway.env").write_text(f"API_SERVER_ENABLED=true\nAPI_SERVER_HOST={api_host}\nAPI_SERVER_PORT=8643\n")


if __name__ == "__main__":
    try:
        render(sys.argv[1], sys.argv[2], Path(sys.argv[3]))
    except (IndexError, ValueError) as error:
        raise SystemExit(str(error)) from None
