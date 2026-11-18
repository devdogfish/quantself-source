#!/usr/bin/env python3
"""Run while the two keep254-network-probe containers are serving synthetic HTTP.
Read-only connection probes; no credentials, production requests or host changes.
Policy tests are complementary: this checks actual routing/firewall/Docker behavior.
Set KEEP_NETWORK_PROBE_TARGETS to the approved private JSON manifest. Supply bare
addresses for every key in load_probe_targets; the default route supplies the
interface scope for link-local cases.
"""
import argparse
import json
import socket
import subprocess
import sys

import ipaddress
import os
import stat


def unique_fields(pairs):
    values = dict(pairs)
    if len(values) != len(pairs):
        raise ValueError
    return values


def load_probe_targets():
    try:
        fd = os.open(os.environ["KEEP_NETWORK_PROBE_TARGETS"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, encoding="utf-8") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 4096:
                raise ValueError
            targets = json.load(file, object_pairs_hook=unique_fields)
        peer_keys = ("files", "app", "httpsAndSsh", "httpsOnly", "proxmox", "pbs")
        management_keys = ("managementSsh", "managementBackup")
        tailnet_key = "filesTailnetV6"
        link_local_keys = (
            "linkLocalHttps", "linkLocalSsh", "linkLocalManagementSsh", "linkLocalManagementBackup",
        )
        keys = (*peer_keys, *management_keys, tailnet_key, *link_local_keys)
        if not isinstance(targets, dict) or set(targets) != set(keys):
            raise ValueError
        if not all(isinstance(value, str) for value in targets.values()):
            raise ValueError
        peers = [ipaddress.IPv4Address(targets[key]) for key in peer_keys]
        management = [ipaddress.IPv4Address(targets[key]) for key in management_keys]
        if len(set(peers)) != len(peers) or len(set(management)) != len(management):
            raise ValueError
        if any(address.is_unspecified or address.is_multicast for address in (*peers, *management)):
            raise ValueError
        tailnet_address = ipaddress.IPv6Address(targets[tailnet_key])
        if tailnet_address.scope_id is not None or tailnet_address not in ipaddress.IPv6Network("fd7a:115c:a1e0::/48"):
            raise ValueError
        link_local = [ipaddress.IPv6Address(targets[key]) for key in link_local_keys]
        if len(set(link_local)) != len(link_local) or any(
            not address.is_link_local or address.scope_id is not None for address in link_local
        ):
            raise ValueError
        return targets
    except (KeyError, OSError, ValueError):
        raise SystemExit("probe_config_errors=1") from None


def report_error(_kind, _error, _trace):
    print("probe_errors=1", file=sys.stderr)


sys.excepthook = report_error

parser = argparse.ArgumentParser()
parser.add_argument('--role', required=True, choices=['owner', 'quantself', 'agent', 'gate'])
parser.add_argument('--source', required=True)
args = parser.parse_args()
probe_targets = load_probe_targets()
files = probe_targets["files"]
app = probe_targets["app"]
# address, port, expected permission, require the synthetic service marker
cases = {
    'owner': [(files,443,True,True), (probe_targets["filesTailnetV6"],443,True,True),
              (app,443,True,True), (app,8443,True,True),
              (files,22,True,False), (app,22,True,False)],
    'quantself': [(files,443,True,True), (files,22,False,False),
                  (probe_targets["managementSsh"],22,False,False), (probe_targets["managementBackup"],8007,False,False),
                  (probe_targets["httpsAndSsh"],443,False,False)],
    'agent': [(app,443,True,True), (app,8443,False,False), (files,443,False,False),
              (probe_targets["filesTailnetV6"],443,False,False),
              (probe_targets["httpsAndSsh"],443,False,False), (probe_targets["httpsAndSsh"],22,False,False),
              (probe_targets["httpsOnly"],443,False,False), (probe_targets["proxmox"],22,False,False),
              (probe_targets["proxmox"],8006,False,False), (probe_targets["pbs"],8007,False,False),
              (probe_targets["pbs"],22,False,False)],
    'gate': [(app,8443,True,True), (app,443,False,False), (files,443,False,False),
             (probe_targets["httpsAndSsh"],443,False,False), (probe_targets["proxmox"],22,False,False),
             (probe_targets["pbs"],8007,False,False)]
}[args.role]
if args.role in ('agent', 'gate'):
    routes = json.loads(subprocess.check_output(['ip', '-j', 'route', 'show', 'default'], stderr=subprocess.DEVNULL))
    interface = routes[0]['dev']
    cases += [(address + '%' + interface, port, False, False) for address, port in [
        (probe_targets["linkLocalHttps"],443), (probe_targets["linkLocalSsh"],22),
        (probe_targets["linkLocalManagementSsh"],22), (probe_targets["linkLocalManagementBackup"],8007)]]
failed = 0
checked = 0
passed_count = 0
for address, port, expected, marker in cases:
    reachable = False
    detail = ''
    marker_ok = not marker
    try:
        with socket.create_connection((address, port), timeout=2) as connection:
            reachable = True
            if marker:
                connection.sendall(b'GET / HTTP/1.0\r\nHost: synthetic.invalid\r\n\r\n')
                body = b''
                while len(body) < 4096:
                    part = connection.recv(4096-len(body))
                    if not part:
                        break
                    body += part
                marker_ok = b'keep254-synthetic' in body
    except OSError as error:
        detail = type(error).__name__
    passed = reachable == expected and marker_ok
    failed += not passed
    checked += 1
    passed_count += int(passed)
print(json.dumps(dict(checks=checked, passed=passed_count, failed=checked - passed_count)))
sys.exit(1 if failed else 0)
