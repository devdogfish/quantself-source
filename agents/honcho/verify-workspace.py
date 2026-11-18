"""Write or read the same synthetic Honcho sessions before and after recovery."""

import argparse
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROLES = ("sam", "stacy", "tyler")
HONCHO_ID = re.compile(r"[a-zA-Z0-9_-]{1,512}")
JWT = re.compile(r"[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+")
RESPONSE_LIMIT = 256 * 1024


class CheckFailed(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Honcho:
    def __init__(self, origin, token):
        self.origin = origin.rstrip("/")
        self.token = token
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, path, body, *, authenticated=True, expected=(200, 201)):
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self.token
        request = Request(self.origin + path, json.dumps(body).encode(), headers, method="POST")
        try:
            with self.opener.open(request, timeout=15) as response:
                if response.status not in expected:
                    raise CheckFailed("Honcho returned an unexpected authorization or success status")
                data = response.read(RESPONSE_LIMIT + 1)
                if len(data) > RESPONSE_LIMIT:
                    raise CheckFailed("Honcho response exceeded the probe limit")
                return json.loads(data)
        except HTTPError as exc:
            status = exc.code
            exc.close()
            if status in expected:
                return None
            raise CheckFailed(f"Honcho returned HTTP {status} during the workspace probe") from None


def expect_id(result, expected):
    if not isinstance(result, dict) or result.get("id") != expected:
        raise CheckFailed("Honcho returned the wrong workspace, peer or session ID")


def messages_for(honcho, path):
    page = honcho.request(path + "/list?size=10", {})
    if not isinstance(page, dict) or not isinstance(page.get("items"), list):
        raise CheckFailed("Honcho did not return a message page")
    return page["items"]


def check_workspace(honcho, workspace, owner, probe_id, action):
    prefix = f"/v3/workspaces/{workspace}"
    sessions = {role: f"{role}-setup-{probe_id}" for role in ROLES}
    first = sessions[ROLES[0]]
    honcho.request(f"{prefix}/sessions/{first}/messages/list", {}, authenticated=False, expected=(401, 403))
    other = f"other-{probe_id}" if workspace != f"other-{probe_id}" else f"denied-{probe_id}"
    honcho.request(f"/v3/workspaces/{other}/sessions/{first}/messages/list", {}, expected=(401, 403))
    if action == "write":
        expect_id(honcho.request("/v3/workspaces", {"id": workspace}), workspace)
        for peer in (owner, *ROLES):
            expect_id(honcho.request(prefix + "/peers", {"id": peer}), peer)
    for role, session in sessions.items():
        path = f"{prefix}/sessions/{session}/messages"
        expected = {
            owner: f"Synthetic setup probe {probe_id}: Owner marker for {role}.",
            role: f"Synthetic setup probe {probe_id}: {role} marker.",
        }
        if action == "write":
            expect_id(honcho.request(prefix + "/sessions", {"id": session, "peers": {owner: {}, role: {}}}), session)
        messages = messages_for(honcho, path)
        if action == "write" and not messages:
            honcho.request(path, {"messages": [{"peer_id": peer, "content": content}
                                               for peer, content in expected.items()]}, expected=(201,))
            messages = messages_for(honcho, path)
        if (len(messages) != len(expected)
                or any(not isinstance(row, dict) or row.get("workspace_id") != workspace
                       or row.get("session_id") != session for row in messages)
                or {row.get("peer_id"): row.get("content") for row in messages} != expected):
            raise CheckFailed("Honcho did not return the Owner and Agent markers in the expected session")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("write", "read"))
    parser.add_argument("site", type=Path, help="The fleet settings JSON used by the Agent installers")
    parser.add_argument("token_file", type=Path, help="A private file with the workspace token")
    parser.add_argument("probe_id", help="Use the same unique ID before and after restore")
    parser.add_argument("--loopback", action="store_true", help="Check the Honcho guest on 127.0.0.1:18081")
    args = parser.parse_args()
    try:
        site = json.loads(args.site.read_text())
        workspace, owner = site["honcho_workspace"], site["honcho_owner_peer"]
        if (not all(isinstance(value, str) and HONCHO_ID.fullmatch(value) for value in (workspace, owner))
                or owner in ROLES or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.probe_id)
                or set(site["agents"]) != set(ROLES)):
            raise CheckFailed("Use one workspace, one distinct Owner peer and the three Agent roles")
        origin = "http://127.0.0.1:18081" if args.loopback else site["honcho_url"]
        parsed = urlsplit(origin)
        if (not args.loopback and (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                                  or parsed.path not in ("", "/") or parsed.query or parsed.fragment)):
            raise CheckFailed("Use a credential-free HTTPS origin from the fleet settings")
        if args.token_file.stat().st_mode & 0o077:
            raise CheckFailed("Token file must be private")
        token = args.token_file.read_text().strip()
        if len(token) > 4096 or not JWT.fullmatch(token):
            raise CheckFailed("Expected one Honcho workspace JWT")
        check_workspace(Honcho(origin, token), workspace, owner, args.probe_id, args.action)
    except CheckFailed as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except (KeyError, OSError, TypeError, ValueError, URLError):
        print("Unable to complete the Honcho probe; inspect the guest and fleet settings", file=sys.stderr)
        return 1
    print(json.dumps({"action": args.action, "probe": args.probe_id, "verified_roles": ROLES}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
