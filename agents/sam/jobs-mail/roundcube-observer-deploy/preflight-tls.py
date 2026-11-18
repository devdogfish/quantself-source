#!/usr/bin/env python3
"""Verify the public IMAP certificate without sending any IMAP bytes."""

import argparse
import datetime
import hashlib
import hmac
import json
import re
import socket
import ssl
import sys


HOST = "imap.purelymail.com"
PORT = 993


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-leaf", metavar="SHA256")
    args = parser.parse_args()
    if args.expect_leaf and not re.fullmatch(r"[0-9a-f]{64}", args.expect_leaf):
        parser.error("--expect-leaf requires a lowercase SHA-256 digest")

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    try:
        with socket.create_connection((HOST, PORT), timeout=5) as connection:
            with context.wrap_socket(connection, server_hostname=HOST) as tls:
                leaf = hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest()
                certificate = tls.getpeercert()
                protocol = tls.version()
    except OSError as error:
        print(f"Provider TLS verification failed: {error}", file=sys.stderr)
        return 1
    if args.expect_leaf and not hmac.compare_digest(leaf, args.expect_leaf):
        print("Provider TLS verified, but the leaf fingerprint differs from the expected pin.", file=sys.stderr)
        return 1

    print(json.dumps({
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "hostname": HOST, "port": PORT, "tls": protocol, "leafSha256": leaf,
        "issuer": dict(entry for component in certificate["issuer"] for entry in component),
        "serial": certificate["serialNumber"], "notAfter": certificate["notAfter"],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
