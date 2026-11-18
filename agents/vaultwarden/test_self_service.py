import asyncio
from base64 import b64decode
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

from self_service import FOLDER, SelfService, account
from service import Vault, VaultLocked, VaultUnavailable, dispatch

SITE = "https://www.login.example.com/login"
ORIGIN = "https://www.login.example.com"
USER = "tyler-fixture"
EMAIL = "tyler@dawnshiftagency.com"
FOLDER_ID = "988d5731-6ae9-4bc4-830f-c49edfe4c936"
ITEM_ID = "70ffbb21-0a6b-41a2-b35d-70237524ac12"
HERMES_UID = 1234
FAKE_SEED = "otpauth://totp/fixture:tyler-fixture?secret=JBSWY3DPEHPK3PXP"


class FakeVault:
    def __init__(self, state):
        self.state = state
        self.bw_serial = asyncio.Lock()
        self.session = "fake-bw-session"
        self.sites = {}
        self.items = []
        self.created = 0
        self.fail_create_reply = False

    sync = AsyncMock()
    unlock = AsyncMock()

    async def run_bw(self, *args, session, data=None):
        assert self.bw_serial.locked() and session == self.session
        if args[:2] == ("list", "items"):
            response = self.items
        elif args == ("list", "folders"):
            response = [{"name": FOLDER, "id": FOLDER_ID}]
        elif args == ("create", "item"):
            assert data is not None
            self.created += 1
            item = json.loads(b64decode(data, validate=True)) | {"id": ITEM_ID}
            assert item["login"]["password"] not in str(args)
            self.items.append(item)
            if self.fail_create_reply:
                raise OSError("fixture create reply lost")
            response = item
        elif args == ("get", "item", ITEM_ID):
            response = self.items[0]
        elif args == ("edit", "item", ITEM_ID):
            self.items[0] = json.loads(b64decode(data, validate=True))
            response = self.items[0]
        elif args == ("get", "totp", ITEM_ID, "--raw"):
            assert self.items[0]["login"]["totp"] == FAKE_SEED
            return b"123456"
        else:
            raise AssertionError(args)
        return json.dumps(response).encode()


class FakeSite:
    def __init__(self):
        self.result = "signed_in"
        self.codes = []
        self.step_results = []
        self.starts = []
        self.posts = 0
        self.closed = False
        self.fail_after_signup = False

    async def start(self, mode, username, password, email, before_submit=None):
        self.starts.append(mode)
        assert username == USER and email == EMAIL
        assert password
        if self.result in {"unsupported", "origin_refused"}:
            return self.result
        if mode == "signup":
            await before_submit()
            self.posts += 1
            if self.fail_after_signup:
                raise OSError("fixture signup reply lost")
        return self.result

    async def totp_seed(self, username, email):
        assert username == USER and email == EMAIL
        return FAKE_SEED

    async def code(self, value):
        self.codes.append(value)
        return self.step_results.pop(0)

    async def close(self):
        self.closed = True

    sign_out = AsyncMock(return_value="signed_out")
    reopen = AsyncMock(return_value="signed_out")
    read = AsyncMock(return_value={"status": "ok", "text": "Fixture account"})


class SelfServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.bw = FakeVault(self.state)
        self.browser = FakeSite()
        self.open_site = AsyncMock(return_value=self.browser)
        self.service = SelfService(self.bw, EMAIL, self.open_site)
        self.key = account(SITE, USER)

    async def action(self, action, **fields):
        return await self.service.act({"action": action, "site": SITE, "username": USER} | fields)

    async def test_account_save_then_create_and_sign_in_again(self):
        self.assertEqual(await self.action("create"), "created")
        self.assertEqual(self.service.load(self.key)["stage"], "ready")
        self.assertEqual(self.bw.created, 1)
        self.assertEqual(self.browser.posts, 1)
        self.assertEqual(self.bw.items[0]["login"]["uris"], [{"uri": SITE, "match": 3}])
        self.assertEqual(await self.action("create"), "existing_account")
        self.assertEqual(await self.action("sign_out"), "signed_out")
        self.assertEqual(await self.action("reopen"), "signed_out")
        self.assertEqual(await self.action("sign_in"), "signed_in")
        self.assertEqual(self.bw.created, 1)
        result = await self.service.read({"site": ORIGIN, "username": USER, "url": None})
        self.assertEqual(result, {"status": "ok", "text": "Fixture account"})
        self.assertNotIn(self.bw.items[0]["login"]["password"], self.service.path(self.key).read_text())

    async def test_unsupported_form_does_not_write_to_vault(self):
        self.browser.result = "unsupported"
        self.assertEqual(await self.action("create"), "unsupported")
        self.assertIsNone(self.service.load(self.key))
        self.assertEqual(self.bw.created, 0)
        self.assertEqual(self.browser.posts, 0)

    async def test_reconciles_lost_vault_reply_without_duplicate(self):
        self.bw.fail_create_reply = True
        with self.assertRaises(OSError):
            await self.action("create")
        self.assertEqual(self.service.load(self.key)["stage"], "saving")
        self.assertEqual(self.browser.posts, 0)
        self.assertEqual(await self.action("create"), "created")
        self.assertEqual(self.bw.created, 1)
        self.assertEqual(self.browser.posts, 1)

    async def test_reconciles_lost_signup_reply_using_sign_in_only(self):
        self.browser.fail_after_signup = True
        with self.assertRaises(OSError):
            await self.action("create")
        self.assertEqual(self.service.load(self.key)["stage"], "submitted")
        self.assertEqual(await self.action("create"), "created")
        self.assertEqual(self.browser.starts, ["signup", "sign_in"])
        self.assertEqual(self.browser.posts, 1)
        self.assertEqual(self.bw.created, 1)

    async def test_email_challenge_only_once_then_saves_and_verifies_totp(self):
        self.browser.result = "email_verification_required"
        self.browser.step_results = ["totp_setup_required", "signed_in"]
        self.assertEqual(await self.action("create"), "email_verification_required")
        self.assertEqual(await self.action("create"), "email_verification_required")
        self.assertEqual(await self.action("verify_email", site="https://wrong.example.com", code="987654"),
                         "sign_in_required")
        self.assertEqual(await self.action("verify_email", code="987654"), "created")
        self.assertEqual(self.browser.codes, ["987654", "123456"])
        self.assertEqual(self.bw.items[0]["login"]["totp"], FAKE_SEED)
        self.assertEqual(await self.action("verify_email", code="987654"), "verification_rejected")
        receipt = self.service.path(self.key).read_text()
        for value in ("987654", "123456", FAKE_SEED):
            self.assertNotIn(value, receipt)

    async def test_unmanaged_and_shared_items_cannot_enter_automatic_flow(self):
        self.bw.items = [{"organizationId": "fixture-owner", "login": {
            "username": USER, "password": "shared-secret",
            "uris": [{"uri": ORIGIN + "/different-login-path", "match": 3}],
        }}]
        self.assertEqual(await self.action("sign_in"), "existing_account")
        self.assertEqual(await self.action("create"), "existing_account")
        self.assertEqual(self.bw.created, 0)
        self.assertEqual(self.browser.posts, 0)
        self.assertIsNone(self.service.load(self.key))

    async def test_ownership_checked_again_on_every_sign_in(self):
        self.assertEqual(await self.action("create"), "created")
        self.bw.items[0]["organizationId"] = "owner-organization"
        with self.assertRaises(ValueError):
            await self.action("sign_in")
        self.assertEqual(self.browser.starts, ["signup"])

    async def test_owner_recipe_takes_precedence_over_managed_account(self):
        self.assertEqual(await self.action("create"), "created")
        self.bw.sites[ITEM_ID] = {}
        self.assertEqual(await self.action("sign_in"), "existing_account")
        self.assertEqual(await self.service.read({"site": SITE, "username": USER, "url": None}),
                         {"status": "sign_in_required"})
        self.assertEqual(self.browser.starts, ["signup"])

    async def test_dispatch_gates_operation_and_keeps_unexpected_exception_private(self):
        vault = Vault("not-installed", self.state, self.state / "credential", FOLDER_ID)
        self.addCleanup(vault.relock)
        request = {"website_account": {"action": "create", "site": SITE, "username": USER}}
        self.assertEqual(await dispatch(vault, HERMES_UID, HERMES_UID, request), {"status": "unavailable"})
        vault.self_service = AsyncMock()
        vault.self_service.act.side_effect = RuntimeError("password-canary")
        self.assertEqual(await dispatch(vault, HERMES_UID, HERMES_UID, request), {"status": "unconfirmed"})
        vault.self_service.close.assert_awaited_once()
        with self.assertRaises(VaultUnavailable):
            await dispatch(vault, HERMES_UID + 1, HERMES_UID, request)
        vault.owner_lock.touch()
        with self.assertRaises(VaultLocked):
            await dispatch(vault, HERMES_UID, HERMES_UID, request)
