#!/usr/bin/python3 -I
"""Bridge between the per-Agent Vaultwarden service and Hermes secrets.command."""
import re
import subprocess
import sys

# #376 supplies this non-interactive client to the separate unlock service.
CLIENT = "/usr/local/libexec/quantself-vaultwarden-keys"
STARTUP_KEYS = ("ANTHROPIC_API_KEY", "HONCHO_API_KEY", "API_SERVER_KEY", "QUANTSELF_API_KEY",
                "BOT_HQ_MCP_TOKEN")


def fetch_keys(names):
    result = subprocess.run(
        [CLIENT, *names], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, check=True, text=True, timeout=14.5,
    )
    values = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if (not separator or key not in names or key in values
                or not re.fullmatch(r"[A-Za-z0-9._~+/=-]{8,4096}", value)):
            raise ValueError("Invalid Vaultwarden response")
        values[key] = value
    if values.keys() != set(names):
        raise ValueError("Missing Vaultwarden keys")
    return values


def main():
    try:
        values = fetch_keys(STARTUP_KEYS)
    except (OSError, subprocess.SubprocessError, ValueError):
        sys.exit("Vaultwarden startup keys unavailable")
    for name in STARTUP_KEYS:
        print(f"{name}={values[name]}")


if __name__ == "__main__":
    main()
