#!/usr/bin/python3 -I
"""Serve the Agent's allowed operations through its private Bitwarden profile."""

import asyncio
import json
import os
import pwd
import re
import socket
import struct
import sys
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from uuid import UUID

KEY_NAMES = frozenset({
    "ANTHROPIC_API_KEY", "HONCHO_API_KEY", "API_SERVER_KEY",
    "QUANTSELF_API_KEY", "BOT_HQ_MCP_TOKEN", "VNC_PASSWORD",
})
KEY_VALUE = re.compile(r"[A-Za-z0-9._~+/=-]{8,4096}")
REQUEST_LIMIT = 16384
LOGIN_STATUS = {"signed_in", "sign_in_blocked", "origin_refused", "transfer_rejected", "unavailable"}
SUBMIT_STATUS = {"submitted", "form_refused", "approval_required", "sign_in_required",
                 "origin_refused", "outcome_unknown", "unavailable"}
APPROVAL_SECONDS = 300


class VaultUnavailable(Exception):
    """A vault operation failed without a diagnostic safe to send to the client."""


class VaultLocked(VaultUnavailable):
    """The Owner has locked the vault."""


def requested_keys(request):
    if not isinstance(request, dict) or request.keys() != {"keys"}:
        raise VaultUnavailable
    names = request["keys"]
    if not isinstance(names, list) or not 1 <= len(names) <= len(KEY_NAMES):
        raise VaultUnavailable
    if any(not isinstance(name, str) or name not in KEY_NAMES for name in names):
        raise VaultUnavailable
    if len(set(names)) != len(names):
        raise VaultUnavailable
    return names


def read_key_notes(items, folder, names):
    if not isinstance(items, list):
        raise VaultUnavailable
    values = {}
    for item in items:
        if not isinstance(item, dict):
            raise VaultUnavailable
        name = item.get("name")
        if name not in names:
            continue
        value = item.get("notes")
        if (name in values or item.get("folderId") != folder or item.get("type") != 2
                or item.get("organizationId") is not None or item.get("deletedDate") is not None
                or not isinstance(value, str) or not KEY_VALUE.fullmatch(value)):
            raise VaultUnavailable
        values[name] = value
    if values.keys() != set(names):
        raise VaultUnavailable
    return {name: values[name] for name in names}


class Vault:
    def __init__(self, bw, state, credential, startup_folder, idle_seconds=1800, sites=None,
                 protected_browser=None, mailbox=None, self_service=None):
        self.bw = bw
        self.state = state
        self.profile = state / "bw"
        self.credential = credential
        self.startup_folder = str(UUID(startup_folder))
        self.idle_seconds = idle_seconds
        self.owner_lock = state / "owner-locked"
        self.session = None
        self.idle_timer = None
        self.active_operations = set()
        self.bw_serial = asyncio.Lock()
        self.browser_serial = asyncio.Lock()
        self.mail_serial = asyncio.Lock()
        self.owner_control = asyncio.Lock()
        self.submit_approval = None
        self.sites = sites or {}
        self.protected_browser = protected_browser
        self.mailbox = mailbox
        self.self_service = self_service

    async def run_bw(self, *args, session=None, data=None):
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.state),
            "BITWARDENCLI_APPDATA_DIR": str(self.profile),
            "NO_COLOR": "1",
        }
        if session is not None:
            env["BW_SESSION"] = session
        process = await asyncio.create_subprocess_exec(
            self.bw, *args, "--nointeraction", env=env,
            stdin=asyncio.subprocess.DEVNULL if data is None else asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await process.communicate() if data is None else await process.communicate(data)
        except asyncio.CancelledError:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            raise
        if process.returncode:
            raise VaultUnavailable
        return stdout

    def cancel_idle_timer(self):
        if self.idle_timer is not None:
            self.idle_timer.cancel()
            self.idle_timer = None

    def relock(self):
        self.cancel_idle_timer()
        self.session = None
        self.submit_approval = None

    async def expire_when_idle(self):
        await asyncio.sleep(self.idle_seconds)
        self.idle_timer = None
        try:
            await self.close()
        except VaultUnavailable:
            print("Vaultwarden protected browser cleanup failed", file=sys.stderr)

    async def set_owner_lock(self, locked):
        async with self.owner_control:
            if locked:
                try:
                    self.owner_lock.touch(mode=0o600, exist_ok=False)
                except FileExistsError:
                    pass
                self.relock()
                for task in self.active_operations:
                    task.cancel()
            if locked or self.owner_lock.exists():
                # Wait for cancelled operations to leave the browser before closing it.
                await self.close()
                if not locked:
                    self.owner_lock.unlink()

    @asynccontextmanager
    async def operation(self, serial, *, relock_on_failure=True):
        async with serial:
            if self.owner_lock.exists():
                raise VaultLocked
            task = asyncio.current_task()
            self.active_operations.add(task)
            self.cancel_idle_timer()
            try:
                yield
            except asyncio.CancelledError:
                locked = self.owner_lock.exists()
                if relock_on_failure or locked:
                    self.relock()
                if locked:
                    raise VaultLocked from None
                raise
            except (OSError, ValueError, VaultUnavailable):
                if relock_on_failure:
                    self.relock()
                raise VaultUnavailable from None
            finally:
                self.active_operations.remove(task)
                if not self.active_operations and (self.session is not None or self.protected_browser is not None
                                                   or self.self_service is not None):
                    self.idle_timer = asyncio.create_task(self.expire_when_idle())

    async def unlock(self):
        if self.session is None:
            token = await self.run_bw("unlock", "--raw", "--passwordfile", str(self.credential))
            token = token.decode("ascii").strip()
            if not token or any(character.isspace() for character in token):
                raise VaultUnavailable
            self.session = token

    async def startup_keys(self, names):
        async with self.operation(self.bw_serial):
            await self.unlock()
            items = await self.run_bw("list", "items", "--folderid", self.startup_folder,
                                      session=self.session)
            return read_key_notes(json.loads(items), self.startup_folder, names)

    async def refresh(self):
        # Let any sign-in using the pre-sync grant finish before reporting the refresh.
        async with self.operation(self.browser_serial):
            async with self.bw_serial:
                await self.sync()

    async def sync(self):
        started = datetime.now(UTC)
        started = started.replace(microsecond=started.microsecond // 1000 * 1000)
        await self.run_bw("sync", "--force")
        last_sync = (await self.run_bw("sync", "--last", "--raw")).decode("ascii").strip()
        synced = datetime.fromisoformat(last_sync)
        if synced.tzinfo is None or synced < started:
            raise VaultUnavailable

    async def synced_login(self, item_id):
        await self.sync()
        await self.unlock()
        item = json.loads(await self.run_bw("get", "item", item_id, session=self.session))
        if (not isinstance(item, dict) or item.get("id") != item_id or item.get("type") != 1
                or item.get("deletedDate") is not None or not isinstance(item.get("login"), dict)):
            raise VaultUnavailable
        login = item["login"]
        username, password = login.get("username"), login.get("password")
        if not isinstance(username, str) or not isinstance(password, str) or not username or not password:
            raise VaultUnavailable
        return login

    async def live_login(self, item_id):
        from cookies import https_origin

        login = await self.synced_login(item_id)
        recipe = self.sites[item_id]
        origin = https_origin(recipe["login_url"])
        uris = login.get("uris")
        if isinstance(uris, list):
            for entry in uris:
                if not isinstance(entry, dict) or entry.get("match") == 5:
                    continue
                saved_url = entry.get("uri")
                try:
                    if https_origin(saved_url) == origin:
                        return saved_url, login
                except ValueError:
                    continue
        return None, login

    async def read_mail(self, request):
        from mail import validate_request

        if self.mailbox is None:
            raise VaultUnavailable
        validate_request(request)
        item_id, username = self.mailbox
        async with self.operation(self.mail_serial, relock_on_failure=False):
            async with self.bw_serial:
                login = await self.synced_login(item_id)
            password = login["password"]
            if (login["username"] != username or len(password) > 256
                    or not password.isascii() or not password.isprintable()):
                raise VaultUnavailable
            return await self.run_mail(username, password, request)

    async def run_mail(self, username, password, request):
        data = json.dumps({"username": username, "password": password, "request": request}).encode()
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-IB", str(Path(__file__).resolve().with_name("mail.py")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            async with asyncio.timeout(20):
                output, _ = await process.communicate(data)
        except (asyncio.CancelledError, TimeoutError):
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            raise
        if process.returncode or len(output) > 30000:
            raise VaultUnavailable
        return json.loads(output)

    async def sign_in(self, item_id):
        if not isinstance(item_id, str) or item_id not in self.sites or self.protected_browser is None:
            raise VaultUnavailable
        from browser import TOTP_CODE

        async with self.operation(self.browser_serial):
            self.submit_approval = None
            # Fail closed before resolving credentials if shared access cannot be checked.
            async with self.bw_serial:
                saved_url, login = await self.live_login(item_id)
            if saved_url is None:
                return "origin_refused"
            recipe = self.sites[item_id]

            async def supply_totp():
                try:
                    async with self.bw_serial:
                        await self.unlock()
                        output = await self.run_bw("get", "totp", item_id, "--raw", session=self.session)
                    code = output.decode("ascii").strip()
                    return code if TOTP_CODE.fullmatch(code) else None
                except (VaultUnavailable, UnicodeError):
                    return None

            extra = {"supply_totp": supply_totp} if "totp" in recipe and login.get("totp") else {}
            result = await self.protected_browser.sign_in(item_id, saved_url, login["username"],
                                                          login["password"], recipe, **extra)
            return result if isinstance(result, str) and result in LOGIN_STATUS else "unavailable"

    async def read_site(self, request):
        if (not isinstance(request, dict) or request.keys() != {"item_id", "url"}
                or not isinstance(request["item_id"], str)
                or request["item_id"] not in self.sites or self.protected_browser is None):
            raise VaultUnavailable
        url = request["url"]
        if url is not None and (not isinstance(url, str) or len(url) > 2048):
            raise VaultUnavailable
        async with self.operation(self.browser_serial):
            return await self.protected_browser.read(request["item_id"], url)

    async def website_account(self, request, read=False):
        if self.self_service is None:
            return {"status": "unavailable"}
        async with self.operation(self.browser_serial, relock_on_failure=False):
            try:
                if read:
                    return await self.self_service.read(request)
                return {"status": await self.self_service.act(request)}
            except Exception:
                # A site or Bitwarden error can contain credential values. Keep it private.
                with suppress(Exception):
                    await self.self_service.close()
                return {"status": "unavailable" if read else "unconfirmed"}

    def form_definition(self, request):
        if (not isinstance(request, dict) or request.keys() != {"item_id", "form", "fields"}
                or not isinstance(request["item_id"], str) or request["item_id"] not in self.sites
                or self.protected_browser is None):
            return None
        form, fields = request["form"], request["fields"]
        forms = self.sites[request["item_id"]].get("forms", {})
        if (not isinstance(form, str) or form not in forms
                or not isinstance(fields, dict) or fields.keys() != forms[form]["fields"].keys()
                or not all(isinstance(value, str) and len(value) <= 4096 for value in fields.values())):
            return None
        return forms[form]

    async def approve_submit_site(self, request):
        definition = self.form_definition(request)
        if definition is None or definition.get("approval", "owner") != "owner":
            raise VaultUnavailable
        async with self.operation(self.browser_serial):
            reviewed = request | {"fields": request["fields"].copy()}
            self.submit_approval = (reviewed, monotonic() + APPROVAL_SECONDS)

    async def submit_site(self, request):
        definition = self.form_definition(request)
        if definition is None:
            return {"status": "form_refused"}
        async with self.operation(self.browser_serial):
            if definition.get("approval") != "autonomous":
                if self.submit_approval is not None and self.submit_approval[1] <= monotonic():
                    self.submit_approval = None
                if self.submit_approval is None or self.submit_approval[0] != request:
                    return {"status": "approval_required"}
                # Consume before Chromium runs. A disconnect or ambiguous write never authorizes replay.
                self.submit_approval = None
            status = await self.protected_browser.submit(request["item_id"], request["form"], request["fields"])
            return {"status": status if status in SUBMIT_STATUS else "outcome_unknown"}

    async def close(self):
        async with self.browser_serial:
            async with self.mail_serial, self.bw_serial:
                self.relock()
            closing = asyncio.gather(*(browser.close() for browser in
                                       (self.protected_browser, self.self_service) if browser is not None),
                                     return_exceptions=True)
            try:
                results = await asyncio.shield(closing)
            except asyncio.CancelledError:
                await asyncio.gather(closing, return_exceptions=True)
                raise
            if any(isinstance(result, BaseException) for result in results):
                raise VaultUnavailable


async def dispatch(vault, peer_uid, hermes_uid, request):
    if isinstance(request, dict) and peer_uid == 0:
        if request.keys() == {"owner_lock"} and type(request["owner_lock"]) is bool:
            await vault.set_owner_lock(request["owner_lock"])
            return {"status": "locked" if request["owner_lock"] else "unlocked"}
        if request == {"refresh": True}:
            await vault.refresh()
            return {"status": "refreshed"}
        if request.keys() == {"approve_submit_site"}:
            await vault.approve_submit_site(request["approve_submit_site"])
            return {"status": "approved"}
    if peer_uid != hermes_uid:
        raise VaultUnavailable
    if isinstance(request, dict) and request.keys() == {"login"}:
        return {"status": await vault.sign_in(request["login"])}
    if isinstance(request, dict) and request.keys() == {"read_site"}:
        return await vault.read_site(request["read_site"])
    if isinstance(request, dict) and request.keys() == {"submit_site"}:
        return await vault.submit_site(request["submit_site"])
    if isinstance(request, dict) and request.keys() == {"mail"}:
        return await vault.read_mail(request["mail"])
    if isinstance(request, dict) and request.keys() == {"website_account"}:
        return await vault.website_account(request["website_account"])
    if isinstance(request, dict) and request.keys() == {"read_account"}:
        return await vault.website_account(request["read_account"], read=True)
    return {"keys": await vault.startup_keys(requested_keys(request))}


def peer_user(connection):
    credentials = struct.Struct("3i")
    _, uid, _ = credentials.unpack(connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, credentials.size))
    return uid


async def operation_until_disconnect(vault, reader, uid, hermes_uid, request):
    operation = asyncio.create_task(dispatch(vault, uid, hermes_uid, request))
    disconnected = asyncio.create_task(reader.read(1))
    try:
        done, _ = await asyncio.wait((operation, disconnected), return_when=asyncio.FIRST_COMPLETED)
        return operation.result() if operation in done else None
    finally:
        disconnected.cancel()
        if not operation.done():
            operation.cancel()
        await asyncio.gather(operation, disconnected, return_exceptions=True)


async def serve(vault, listener, hermes_uid, identify_peer=peer_user):
    async def handle(reader, writer):
        is_submit = False
        is_account = False
        try:
            async with asyncio.timeout(1):
                uid = identify_peer(writer.get_extra_info("socket"))
                data = await reader.readline()
                if not data.endswith(b"\n"):
                    raise VaultUnavailable
                request = json.loads(data)
            is_submit = isinstance(request, dict) and uid == hermes_uid and request.keys() == {"submit_site"}
            is_account = isinstance(request, dict) and uid == hermes_uid and request.keys() == {"website_account"}
            cancellable = (uid == hermes_uid and isinstance(request, dict)
                           and request.keys() in ({"login"}, {"read_site"}, {"submit_site"}, {"mail"},
                                                  {"website_account"}, {"read_account"}))
            if cancellable:
                async with asyncio.timeout(90 if is_account else 40):
                    result = await operation_until_disconnect(vault, reader, uid, hermes_uid, request)
            else:
                is_startup = uid == hermes_uid and isinstance(request, dict) and request.keys() == {"keys"}
                # A second startup request may queue behind the cold CLI unlock.
                async with asyncio.timeout(13 if is_startup else 10):
                    result = await dispatch(vault, uid, hermes_uid, request)
        except VaultLocked:
            result = {"status": "outcome_unknown"} if is_submit else {"error": "locked"}
        except (OSError, ValueError, TimeoutError, VaultUnavailable):
            result = ({"status": "outcome_unknown"} if is_submit else
                      {"status": "unconfirmed"} if is_account else {"error": "unavailable"})
        except asyncio.CancelledError:
            writer.close()
            raise
        try:
            if result is not None:
                writer.write(json.dumps(result, ensure_ascii=False).encode() + b"\n")
                async with asyncio.timeout(1):
                    await writer.drain()
        except (OSError, TimeoutError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_unix_server(handle, sock=listener, limit=REQUEST_LIMIT)
    async with server:
        await server.serve_forever()


def main():
    try:
        if os.environ.get("LISTEN_PID") != str(os.getpid()) or os.environ.get("LISTEN_FDS") != "1":
            raise VaultUnavailable
        listener = socket.socket(fileno=3)
        if listener.family != socket.AF_UNIX or not listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN):
            raise VaultUnavailable
        state = Path(os.environ["STATE_DIRECTORY"])
        credential = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "unlock"
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        sites = json.loads(Path(os.environ["VAULTWARDEN_SITES"]).read_text())
        if not isinstance(sites, dict) or any(str(UUID(item_id)) != item_id for item_id in sites):
            raise VaultUnavailable
        protected_browser = None
        if sites:
            from browser import ProtectedBrowser, validate_recipe
            for recipe in sites.values():
                if not isinstance(recipe, dict) or not isinstance(recipe.get("login_url"), str):
                    raise VaultUnavailable
                validate_recipe(recipe["login_url"], recipe)
            protected_browser = ProtectedBrowser()
        item_id = os.environ.get("VAULTWARDEN_MAIL_ITEM")
        username = os.environ.get("VAULTWARDEN_MAIL_USERNAME")
        mailbox = None
        if item_id is not None or username is not None:
            if (not item_id or str(UUID(item_id)) != item_id or item_id in sites
                    or username not in {"tyler@dawnshiftagency.com", "stacy@dawnshiftagency.com",
                                        "sam@dawnshiftagency.com"}):
                raise VaultUnavailable
            mailbox = (item_id, username)
        vault = Vault("bw", state, credential, os.environ["VAULTWARDEN_STARTUP_FOLDER"],
                      sites=sites, protected_browser=protected_browser, mailbox=mailbox)
        self_service_role = os.environ.get("VAULTWARDEN_SELF_SERVICE")
        if self_service_role is not None:
            if mailbox is None or mailbox[1] != f"{self_service_role}@dawnshiftagency.com":
                raise VaultUnavailable
            from self_service import SelfService
            from self_service_browser import open_site
            vault.self_service = SelfService(vault, mailbox[1], open_site)

        async def run():
            try:
                await serve(vault, listener, pwd.getpwnam("hermes").pw_uid)
            finally:
                await vault.close()

        asyncio.run(run())
    except (ImportError, OSError, KeyError, TypeError, ValueError, VaultUnavailable):
        raise SystemExit("Vaultwarden service unavailable") from None


if __name__ == "__main__":
    main()
