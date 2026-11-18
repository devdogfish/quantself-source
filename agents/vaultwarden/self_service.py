"""Private ownership and retry state for self-service website accounts."""

from base64 import b64encode
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from secrets import token_urlsafe
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit
from uuid import UUID

from cookies import CookieRefused, https_origin

FOLDER = "Self-service website accounts"
USERNAME = re.compile(r"[A-Za-z0-9_.@+-]{1,128}")
CODE = re.compile(r"[0-9]{4,10}")
STAGES = {"saving", "saved", "submitted", "ready"}


def account(site, username):
    if (not isinstance(site, str) or len(site) > 2048
            or not isinstance(username, str) or not USERNAME.fullmatch(username)):
        raise ValueError("invalid account")
    host, port = https_origin(site)
    parts = urlsplit(site)
    if parts.query or parts.fragment:
        raise ValueError("invalid account origin")
    authority = f"[{host}]" if ":" in host else host
    if port != 443:
        authority += f":{port}"
    return "https://" + authority, username.casefold()


def own_login(item, record):
    return (
        isinstance(item, dict) and item.get("type") == 1 and item.get("organizationId") is None
        and item.get("deletedDate") is None and item.get("folderId") == record["folder"]
        and item.get("name") == record["name"] and item.get("notes") == record["marker"]
        and isinstance(item.get("login"), dict)
        and item["login"].get("username") == record["username"]
        and isinstance(item["login"].get("password"), str) and bool(item["login"]["password"])
        and isinstance(item["login"].get("uris"), list) and len(item["login"]["uris"]) == 1
        and isinstance(item["login"]["uris"][0], dict)
        and item["login"]["uris"][0].get("uri") == record["site"]
        and item["login"]["uris"][0].get("match") == 3
    )


class SelfService:
    def __init__(self, vault, email, open_site):
        self.vault = vault
        self.email = email
        self.open_site = open_site
        self.browser = None
        self.key = None
        self.email_challenge = None

    def path(self, key):
        digest = sha256("\0".join(key).encode()).hexdigest()
        return self.vault.state / ("website-" + digest + ".json")

    def load(self, key):
        try:
            record = json.loads(self.path(key).read_text())
        except FileNotFoundError:
            return None
        if (not isinstance(record, dict) or record.get("stage") not in STAGES
                or account(record["site"], record["username"]) != key
                or str(UUID(record["folder"])) != record["folder"]
                or not isinstance(record.get("name"), str)
                or not isinstance(record.get("marker"), str)
                or (record["stage"] != "saving" and str(UUID(record["item_id"])) != record["item_id"])):
            raise ValueError("invalid website account receipt")
        return record

    def save(self, key, record):
        target = self.path(key)
        with NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as handle:
            scratch = Path(handle.name)
            try:
                json.dump(record, handle)
                handle.flush()
                os.fsync(handle.fileno())
                os.replace(scratch, target)
                directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                scratch.unlink(missing_ok=True)

    async def bw_json(self, *args, data=None):
        output = await self.vault.run_bw(*args, session=self.vault.session, data=data)
        if len(output) > 2_000_000:
            raise ValueError("vault response too large")
        return json.loads(output)

    async def bw_write(self, command, kind, data, *args):
        return await self.bw_json(command, kind, *args, data=b64encode(json.dumps(data).encode()))

    async def sync(self):
        await self.vault.sync()
        await self.vault.unlock()

    async def folder(self):
        folders = await self.bw_json("list", "folders")
        matches = [folder for folder in folders if folder.get("name") == FOLDER]
        if len(matches) > 1:
            raise ValueError("ambiguous website folder")
        if matches:
            return str(UUID(matches[0]["id"]))
        # Reconcile a lost create reply on the next synchronized list.
        reservation = self.vault.state / "website-folder-create"
        with reservation.open("x"):
            folder = await self.bw_write("create", "folder", {"name": FOLDER})
        if folder.get("name") != FOLDER:
            raise ValueError("website folder unconfirmed")
        return str(UUID(folder["id"]))

    async def save_login(self, key, site, username, password):
        async with self.vault.bw_serial:
            await self.sync()
            # CLI URL matching would miss an exact URI saved with a different path.
            items = await self.bw_json("list", "items")
            for item in items:
                login = item.get("login") or {}
                for entry in login.get("uris") or ():
                    try:
                        if account(entry["uri"], login["username"]) == key:
                            return None
                    except (KeyError, ValueError):
                        continue
            record = {
                "stage": "saving", "folder": await self.folder(), "site": site, "username": username,
                "name": f"{urlsplit(site).hostname} ({username})",
                "marker": "#376 self-service account " + token_urlsafe(18),
            }
            self.save(key, record)
            item = await self.bw_write("create", "item", {
                "type": 1, "folderId": record["folder"], "name": record["name"], "notes": record["marker"],
                "organizationId": None, "favorite": False,
                "login": {"username": username, "password": password, "uris": [{"uri": site, "match": 3}]},
            })
            if not own_login(item, record) or item["login"]["password"] != password:
                raise ValueError("website item unconfirmed")
            return self.saved(key, record, item)

    def saved(self, key, record, item):
        if not own_login(item, record):
            raise ValueError("website item unconfirmed")
        record = record | {"stage": "saved", "item_id": str(UUID(item["id"]))}
        self.save(key, record)
        return record

    async def recover_saving(self, key, record):
        async with self.vault.bw_serial:
            await self.sync()
            items = await self.bw_json("list", "items", "--search", record["name"])
            matches = [item for item in items if own_login(item, record)]
            if len(matches) == 1:
                return self.saved(key, record, matches[0])
        return None

    async def get_item(self, record):
        if record["item_id"] in self.vault.sites:
            raise ExistingAccount
        await self.sync()
        item = await self.bw_json("get", "item", record["item_id"])
        if not own_login(item, record) or item.get("id") != record["item_id"]:
            raise ValueError("website item refused")
        return item

    async def current_code(self, record, seed=None):
        async with self.vault.bw_serial:
            item = await self.get_item(record)
            if seed is not None and seed != item["login"].get("totp"):
                item["login"]["totp"] = seed
                updated = await self.bw_write("edit", "item", item, record["item_id"])
                if (not own_login(updated, record) or updated.get("id") != record["item_id"]
                        or updated["login"].get("totp") != seed):
                    raise ValueError("TOTP enrollment unconfirmed")
            elif not item["login"].get("totp"):
                raise ValueError("TOTP is unavailable")
            raw = await self.vault.run_bw("get", "totp", record["item_id"], "--raw", session=self.vault.session)
            code = raw.decode("ascii").strip()
            if not re.fullmatch(r"[0-9]{6,8}", code):
                raise ValueError("TOTP code refused")
            return code

    async def close(self):
        browser, self.browser = self.browser, None
        self.key = self.email_challenge = None
        if browser is not None:
            await browser.close()

    async def finish(self, key, record, status):
        if status in {"totp_setup_required", "totp_required"}:
            seed = None
            if status == "totp_setup_required":
                seed = await self.browser.totp_seed(record["username"], self.email)
                if seed is None:
                    return "unsupported"
            status = await self.browser.code(await self.current_code(record, seed))
        if status == "email_verification_required":
            self.email_challenge = key
            return status
        if status == "signed_in":
            if record["stage"] != "ready":
                self.save(key, record | {"stage": "ready"})
                return "created"
            return status
        if status in {"unsupported", "origin_refused", "verification_rejected", "unconfirmed"}:
            return status
        return "unconfirmed"

    async def act(self, request):
        if not isinstance(request, dict) or not {"action", "site", "username"} <= request.keys():
            return "unavailable"
        action = request["action"]
        fields = {"action", "site", "username"}
        if (not isinstance(action, str)
                or action not in {"create", "sign_in", "sign_out", "reopen", "verify_email"}
                or request.keys() != fields | ({"code"} if action == "verify_email" else set())):
            return "unavailable"
        site, username = request["site"], request["username"]
        try:
            key = account(site, username)
        except (CookieRefused, ValueError):
            return "origin_refused"
        record = self.load(key)
        if action in {"sign_out", "reopen", "verify_email"}:
            if record is None or self.key != key or self.browser is None:
                return "sign_in_required"
            if action == "sign_out":
                self.email_challenge = None
                return await self.browser.sign_out()
            if action == "reopen":
                self.email_challenge = None
                return await self.browser.reopen()
            code = request["code"]
            if self.email_challenge != key or not isinstance(code, str) or not CODE.fullmatch(code):
                return "verification_rejected"
            self.email_challenge = None
            return await self.finish(key, record, await self.browser.code(code))
        if record is None and action != "create":
            return "existing_account"
        if record is not None and record["stage"] == "ready" and action == "create":
            return "existing_account"
        if record is not None and record["stage"] == "saving":
            record = await self.recover_saving(key, record)
            if record is None:
                return "unconfirmed"
        if record is not None and record["item_id"] in self.vault.sites:
            return "existing_account"
        if self.key == key and self.email_challenge == key:
            return "email_verification_required"
        if action == "sign_in" and record["stage"] == "saved":
            return "sign_in_required"
        await self.close()
        try:
            self.browser = await self.open_site(site if record is None else record["site"])
        except CookieRefused:
            return "origin_refused"
        self.key = key
        if record is None:
            password = token_urlsafe(24)
        else:
            async with self.vault.bw_serial:
                item = await self.get_item(record)
            username, password = item["login"]["username"], item["login"]["password"]

        async def before_submit():
            nonlocal record
            if record is None:
                record = await self.save_login(key, site, username, password)
                if record is None:
                    raise ExistingAccount
            if record["stage"] == "saved":
                record = record | {"stage": "submitted"}
                self.save(key, record)

        signup = action == "create" and (record is None or record["stage"] == "saved")
        try:
            status = await self.browser.start("signup" if signup else "sign_in", username, password,
                                              self.email, before_submit if signup else None)
        except ExistingAccount:
            return "existing_account"
        if record is None:
            return status if status in {"unsupported", "origin_refused", "unconfirmed"} else "unconfirmed"
        return await self.finish(key, record, status)

    async def read(self, request):
        if not isinstance(request, dict) or request.keys() != {"site", "username", "url"}:
            return {"status": "unavailable"}
        try:
            key = account(request["site"], request["username"])
        except (CookieRefused, ValueError):
            return {"status": "origin_refused"}
        url = request["url"]
        if url is not None and (not isinstance(url, str) or len(url) > 2048):
            return {"status": "unavailable"}
        record = self.load(key)
        if (record is None or record["stage"] != "ready" or record["item_id"] in self.vault.sites
                or self.key != key or self.browser is None):
            return {"status": "sign_in_required"}
        return await self.browser.read(url)


class ExistingAccount(Exception):
    """An unmanaged login already matches this origin and username."""
