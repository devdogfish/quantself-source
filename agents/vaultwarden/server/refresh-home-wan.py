#!/usr/bin/python3 -I
"""Refresh the host firewall's home WAN block for Vaultwarden VM 2549."""
import argparse
import ipaddress
import os
import subprocess
import tempfile
from pathlib import Path


def refresh(directory, seed=False):
    trace = subprocess.check_output(
        ["/usr/bin/curl", "-4fsS", "--max-time", "8", "https://1.1.1.1/cdn-cgi/trace"],
        stderr=subprocess.DEVNULL, text=True,
    )
    raw, = [line[3:].strip() for line in trace.splitlines() if line.startswith("ip=")]
    address = ipaddress.IPv4Address(raw)
    if not address.is_global:
        raise ValueError("Expected a public WAN IPv4 address")
    config = f"define site_wan_ipv4 = {address}\n"
    if not seed:
        update = (
            "flush set inet vaultwarden_2549 home_wan_ipv4\n"
            f"add element inet vaultwarden_2549 home_wan_ipv4 {{ {address} }}\n"
        )
        subprocess.run(["/usr/sbin/nft", "--file", "-"], input=update, text=True, check=True)

    target = directory / "home-wan.nft"
    if target.exists() and target.read_text() == config:
        return
    with tempfile.NamedTemporaryFile("w", dir=directory, delete=False) as staged:
        staged.write(config)
    os.replace(staged.name, target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", action="store_true", help="Write the initial include before bringing up the bridge")
    args = parser.parse_args()
    try:
        refresh(Path("/etc/vaultwarden-2549"), seed=args.seed)
    except (OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, "Vaultwarden WAN block refresh failed\n")
