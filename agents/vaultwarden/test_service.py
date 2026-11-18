import asyncio
import io
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import browser
import keys
import plugin
from service import Vault, VaultLocked, VaultUnavailable, dispatch, read_key_notes, serve

FOLDER = "b1f2c438-8192-4ac8-940a-09d673d25fda"
NAME = "HONCHO_API_KEY"
VALUE = "synthetic-key-value"
HERMES_UID = 1234
LOGIN_ITEM = "75a0e691-9a78-4857-9017-1897e2daa7aa"
MAIL_USERNAME = "tyler@dawnshiftagency.com"
MAIL_PASSWORD = "fixture-mail-password"

FAKE_BW = """import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

profile = Path(os.environ["BITWARDENCLI_APPDATA_DIR"])
assert sys.argv[-1] == "--nointeraction"
with (profile / "calls").open("a") as log:
    log.write(sys.argv[1] + "\\n")
if sys.argv[1:4] == ["unlock", "--raw", "--passwordfile"]:
    assert "BW_SESSION" not in os.environ
    assert Path(sys.argv[4]).read_text() == "synthetic-password"
    print("synthetic-session")
elif sys.argv[1:4] == ["list", "items", "--folderid"]:
    assert os.environ["BW_SESSION"] == "synthetic-session"
    if (profile / "hold").exists():
        (profile / "waiting").touch()
        time.sleep(60)
    print((profile / "items.json").read_text())
elif sys.argv[1:3] == ["sync", "--force"]:
    if not (profile / "stale-sync").exists():
        (profile / "last-sync").write_text(datetime.now(UTC).isoformat(timespec="milliseconds"))
        if (profile / "updated-items.json").exists():
            (profile / "items.json").write_text((profile / "updated-items.json").read_text())
        if (profile / "revoke-login").exists():
            (profile / "login-item.json").unlink(missing_ok=True)
elif sys.argv[1:4] == ["sync", "--last", "--raw"]:
    print((profile / "last-sync").read_text())
elif sys.argv[1:3] == ["get", "item"]:
    assert os.environ["BW_SESSION"] == "synthetic-session"
    print((profile / "login-item.json").read_text())
elif sys.argv[1:3] == ["get", "totp"]:
    assert len(sys.argv) == 6 and sys.argv[4] == "--raw"
    assert os.environ["BW_SESSION"] == "synthetic-session"
    print((profile / "totp-code").read_text())
else:
    raise SystemExit(1)
"""


def note(**overrides):
    return {
        "name": NAME, "notes": VALUE, "folderId": FOLDER,
        "type": 2, "organizationId": None, "deletedDate": None,
    } | overrides


class NotesTest(unittest.TestCase):
    def test_reads_only_requested_private_secure_notes(self):
        self.assertEqual(read_key_notes([note(), note(name="unrelated")], FOLDER, [NAME]), {NAME: VALUE})

    def test_refuses_ambiguous_missing_or_unsafe_notes(self):
        for items in (
            [note(), note()], [], [note(type=1)], [note(organizationId="org")],
            [note(deletedDate="date")], [note(folderId="wrong")], [note(notes="x\nKEY=other")],
        ):
            with self.subTest(items=items), self.assertRaises(VaultUnavailable):
                read_key_notes(items, FOLDER, [NAME])


class VaultTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name)
        profile = self.state / "bw"
        profile.mkdir()
        (profile / "items.json").write_text(json.dumps([note()]))
        self.credential = self.state / "synthetic-credential"
        self.credential.write_text("synthetic-password")
        self.bw = self.state / "bw-fixture"
        self.bw.write_text(f"#!{sys.executable}\n" + FAKE_BW)
        self.bw.chmod(0o700)
        self.vault = self.make_vault()
        self.addCleanup(self.vault.relock)

    def make_vault(self, idle_seconds=1800):
        return Vault(self.bw, self.state, self.credential, FOLDER, idle_seconds)

    def calls(self):
        return (self.state / "bw/calls").read_text().splitlines()

    def configure_mail(self, username=MAIL_USERNAME):
        self.vault.mailbox = (LOGIN_ITEM, MAIL_USERNAME)
        (self.state / "bw/login-item.json").write_text(json.dumps({
            "id": LOGIN_ITEM, "type": 1, "organizationId": "fixture-shared",
            "login": {"username": username, "password": MAIL_PASSWORD},
        }))

    async def test_mail_reads_only_the_pinned_item_after_fresh_sync(self):
        self.configure_mail()
        payload = {"limit": 10}
        reply = {"status": "ok", "uidvalidity": 31, "messages": []}
        with patch.object(self.vault, "run_mail", new_callable=AsyncMock, return_value=reply) as imap:
            result = await dispatch(self.vault, HERMES_UID, HERMES_UID, {"mail": payload})
            self.assertEqual(result, reply)
            self.assertNotIn(MAIL_PASSWORD, json.dumps(result))
            self.assertEqual(self.calls(), ["sync", "sync", "unlock", "get"])
            imap.assert_awaited_once_with(MAIL_USERNAME, MAIL_PASSWORD, payload)

    async def test_mail_refuses_unconfigured_or_unapproved_scope_without_sync(self):
        request = {"mail": {"limit": 1}}
        with self.assertRaises(VaultUnavailable):
            await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
        self.configure_mail()
        for uid in (0, HERMES_UID + 1):
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, uid, HERMES_UID, request)
        for override in ({"username": "sam@dawnshiftagency.com"}, {"mailbox": "Sent"},
                         {"item_id": LOGIN_ITEM}, {"host": "example.invalid"}, {"command": "STORE"}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, {"mail": request["mail"] | override})
        self.assertFalse((self.state / "bw/calls").exists())

    async def test_mail_fails_closed_for_mismatch_failed_sync_and_revoked_login(self):
        request = {"mail": {"limit": 1}}
        self.configure_mail("stacy@dawnshiftagency.com")
        with patch.object(self.vault, "run_mail", new_callable=AsyncMock) as imap:
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
            self.configure_mail()
            profile = self.state / "bw"
            (profile / "last-sync").write_text("2000-01-01T00:00:00+00:00")
            (profile / "stale-sync").touch()
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
            (profile / "stale-sync").unlink()
            (profile / "revoke-login").touch()
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
            imap.assert_not_awaited()

    async def test_mail_timeout_preserves_an_unrelated_website_approval(self):
        self.configure_mail()
        approval = object()
        self.vault.submit_approval = approval
        with patch.object(self.vault, "run_mail", side_effect=TimeoutError):
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, {"mail": {"limit": 1}})
        self.assertIs(self.vault.submit_approval, approval)

    async def test_owner_lock_kills_active_mail_worker_and_refuses_new_reads(self):
        self.configure_mail()
        started = asyncio.Event()
        spawn = asyncio.create_subprocess_exec
        workers = []

        async def launch_mail(*arguments, **options):
            self.assertEqual(arguments[0], sys.executable)
            self.assertEqual(Path(arguments[-1]).name, "mail.py")
            self.assertNotIn(MAIL_PASSWORD, " ".join(arguments))
            self.assertNotIn(MAIL_PASSWORD, json.dumps(options))
            worker = await spawn(sys.executable, "-IB", "-c", "import sys,time; sys.stdin.read(); time.sleep(60)",
                                 **options)
            workers.append(worker)
            started.set()
            return worker

        async def select_process(*arguments, **options):
            if str(arguments[-1]).endswith("/mail.py"):
                return await launch_mail(*arguments, **options)
            return await spawn(*arguments, **options)

        request = {"mail": {"limit": 1}}
        with patch("service.asyncio.create_subprocess_exec", side_effect=select_process):
            read = asyncio.create_task(dispatch(self.vault, HERMES_UID, HERMES_UID, request))
            try:
                async with asyncio.timeout(5):
                    await started.wait()
                    self.assertEqual(await self.vault.startup_keys([NAME]), {NAME: VALUE})
                    await self.vault.set_owner_lock(True)
                    with self.assertRaises(VaultLocked):
                        await read
                    self.assertIsNotNone(workers[0].returncode)
                    with self.assertRaises(VaultLocked):
                        await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
            finally:
                read.cancel()
                await asyncio.gather(read, return_exceptions=True)

    async def test_concurrent_requests_share_one_unlock_and_read_cached_notes_in_bulk(self):
        expected = {NAME: VALUE}
        self.assertEqual(await asyncio.gather(
            self.vault.startup_keys([NAME]), self.vault.startup_keys([NAME]),
        ), [expected, expected])
        self.assertEqual(self.calls(), ["unlock", "list", "list"])

    async def test_idle_expiry_mints_a_fresh_session(self):
        vault = self.make_vault(idle_seconds=0.01)
        self.addAsyncCleanup(vault.close)
        await vault.startup_keys([NAME])
        await asyncio.sleep(0.05)
        self.assertIsNone(vault.session)
        self.assertEqual(await vault.startup_keys([NAME]), {NAME: VALUE})
        self.assertEqual(self.calls(), ["unlock", "list", "unlock", "list"])

    async def test_idle_closes_protected_browser_before_next_browser_request(self):
        vault = self.make_vault(idle_seconds=0.01)
        vault.protected_browser = browser.ProtectedBrowser()
        vault.sites = {LOGIN_ITEM: {}}
        self.addAsyncCleanup(vault.close)
        started, finish = asyncio.Event(), asyncio.Event()

        async def close_browser():
            started.set()
            await finish.wait()

        with patch.object(vault.protected_browser, "close", side_effect=close_browser):
            # A protected browser may still exist after a failed request cleared the vault token.
            await vault.read_site({"item_id": LOGIN_ITEM, "url": None})
            async with asyncio.timeout(2):
                await started.wait()
                try:
                    request = asyncio.create_task(vault.read_site({"item_id": LOGIN_ITEM, "url": None}))
                    self.assertEqual(await vault.startup_keys([NAME]), {NAME: VALUE})
                    self.assertFalse(request.done())
                finally:
                    finish.set()
                self.assertEqual(await request, {"status": "sign_in_required"})

    async def test_startup_keys_and_owner_lock_while_browser_read_is_pending(self):
        self.vault.protected_browser = browser.ProtectedBrowser()
        self.vault.sites = {LOGIN_ITEM: {}}
        self.addAsyncCleanup(self.vault.close)
        started = asyncio.Event()

        async def hold_browser_read(*args):
            started.set()
            await asyncio.Future()

        with patch.object(self.vault.protected_browser, "read", side_effect=hold_browser_read):
            browser_read = asyncio.create_task(self.vault.read_site({"item_id": LOGIN_ITEM, "url": None}))
            try:
                async with asyncio.timeout(2):
                    await started.wait()
                    self.assertEqual(await self.vault.startup_keys([NAME]), {NAME: VALUE})
                    self.assertFalse(browser_read.done())
                    profile = self.state / "bw"
                    (profile / "hold").touch()
                    key_read = asyncio.create_task(self.vault.startup_keys([NAME]))
                    try:
                        while not (profile / "waiting").exists():
                            await asyncio.sleep(0.01)
                        await self.vault.set_owner_lock(True)
                        with self.assertRaises(VaultLocked):
                            await key_read
                        with self.assertRaises(VaultLocked):
                            await browser_read
                    finally:
                        key_read.cancel()
                        await asyncio.gather(key_read, return_exceptions=True)
            finally:
                browser_read.cancel()
                await asyncio.gather(browser_read, return_exceptions=True)

    async def test_owner_lock_cancels_active_read_and_survives_a_fresh_process_state(self):
        profile = self.state / "bw"
        (profile / "hold").touch()
        read = asyncio.create_task(self.vault.startup_keys([NAME]))
        try:
            async with asyncio.timeout(2):
                while not (profile / "waiting").exists():
                    await asyncio.sleep(0.01)
            self.assertEqual(await dispatch(self.vault, 0, HERMES_UID, {"owner_lock": True}),
                             {"status": "locked"})
            with self.assertRaises(VaultLocked):
                await read
        finally:
            if not read.done():
                read.cancel()
                await asyncio.gather(read, return_exceptions=True)
        self.assertIsNone(self.vault.session)
        restarted = self.make_vault()
        self.addCleanup(restarted.relock)
        with self.assertRaises(VaultLocked):
            await restarted.startup_keys([NAME])
        with self.assertRaises(VaultUnavailable):
            await dispatch(restarted, HERMES_UID, HERMES_UID, {"owner_lock": False})
        (profile / "hold").unlink()
        self.assertEqual(await dispatch(restarted, 0, HERMES_UID, {"owner_lock": False}),
                         {"status": "unlocked"})
        self.assertEqual(await restarted.startup_keys([NAME]), {NAME: VALUE})

    async def test_owner_lock_clears_protected_sessions_before_unlock_can_resume(self):
        self.vault.sites = {LOGIN_ITEM: {}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        self.addAsyncCleanup(self.vault.close)
        self.vault.protected_browser.sessions[LOGIN_ITEM] = object()
        with patch.object(self.vault.protected_browser, "close",
                          wraps=self.vault.protected_browser.close) as close:
            self.assertEqual(await dispatch(self.vault, 0, HERMES_UID, {"owner_lock": True}),
                             {"status": "locked"})
            close.assert_awaited_once()
        await dispatch(self.vault, 0, HERMES_UID, {"owner_lock": False})
        self.assertEqual(await self.vault.read_site({"item_id": LOGIN_ITEM, "url": None}),
                         {"status": "sign_in_required"})

    async def test_refuses_other_signalers_and_arbitrary_vault_reads(self):
        for uid, request in (
            (321, {"keys": [NAME]}),
            (HERMES_UID, {"keys": ["WEBSITE_PASSWORD"]}),
            (HERMES_UID, {"keys": [NAME, NAME]}),
            (HERMES_UID, {"keys": [{}]}),
        ):
            with self.subTest(uid=uid, request=request), self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, uid, HERMES_UID, request)
        self.assertFalse((self.state / "bw/calls").exists())
        self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, {"keys": [NAME]}),
                         {"keys": {NAME: VALUE}})

    async def test_owner_sync_updates_the_cache_without_exposing_new_keys(self):
        rotated = "synthetic-rotated-key"
        (self.state / "bw/updated-items.json").write_text(json.dumps([note(notes=rotated)]))
        result = await dispatch(self.vault, 0, HERMES_UID, {"refresh": True})
        self.assertEqual(result, {"status": "refreshed"})
        self.assertEqual(await self.vault.startup_keys([NAME]), {NAME: rotated})

    async def test_owner_refresh_waits_for_pending_sign_in_before_syncing_revocation(self):
        url = "https://www.login.example.com/login"
        profile = self.state / "bw"
        (profile / "login-item.json").write_text(json.dumps({
            "id": LOGIN_ITEM, "type": 1, "login": {
                "username": "fixture", "password": "synthetic-site-password",
                "uris": [{"uri": url}],
            },
        }))
        self.vault.sites = {LOGIN_ITEM: {"login_url": url}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        browser_started, finish_browser, refresh_started = (asyncio.Event() for _ in range(3))

        async def hold_browser_sign_in(*args):
            browser_started.set()
            await finish_browser.wait()
            return "signed_in"

        async def refresh_as_owner():
            refresh_started.set()
            return await dispatch(self.vault, 0, HERMES_UID, {"refresh": True})

        request = {"login": LOGIN_ITEM}
        tasks = []
        with patch.object(self.vault.protected_browser, "sign_in", side_effect=hold_browser_sign_in) as sign_in:
            try:
                async with asyncio.timeout(2):
                    pending_login = asyncio.create_task(dispatch(self.vault, HERMES_UID, HERMES_UID, request))
                    tasks.append(pending_login)
                    await browser_started.wait()
                    (profile / "revoke-login").touch()
                    with patch.object(self.vault, "sync", wraps=self.vault.sync) as sync:
                        refresh = asyncio.create_task(refresh_as_owner())
                        tasks.append(refresh)
                        await refresh_started.wait()
                        sync.assert_not_awaited()
                        self.assertEqual(await self.vault.startup_keys([NAME]), {NAME: VALUE})
                        self.assertFalse(refresh.done())
                        finish_browser.set()
                        self.assertEqual(await pending_login, {"status": "signed_in"})
                        self.assertEqual(await refresh, {"status": "refreshed"})
                        sync.assert_awaited_once()
                    with self.assertRaises(VaultUnavailable):
                        await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
                    sign_in.assert_awaited_once()
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def test_login_requires_live_sync_and_saved_origin_before_calling_browser(self):
        approved = "https://www.login.example.com/login"
        login = {"username": "fixture", "password": "synthetic-site-password",
                 "uris": [{"uri": "https://wrong.example.org/login"}]}
        item = {"id": LOGIN_ITEM, "type": 1, "login": login}
        profile = self.state / "bw"
        item_file = profile / "login-item.json"
        item_file.write_text(json.dumps(item))
        self.vault.sites = {LOGIN_ITEM: {"login_url": approved}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        with patch.object(self.vault.protected_browser, "sign_in", new_callable=AsyncMock,
                          return_value="sign_in_blocked") as sign_in:
            (profile / "last-sync").write_text("2000-01-01T00:00:00+00:00")
            (profile / "stale-sync").touch()
            request = {"login": LOGIN_ITEM}
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, request)
            self.assertEqual(self.calls(), ["sync", "sync"])
            (profile / "stale-sync").unlink()
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, request),
                             {"status": "origin_refused"})
            sign_in.assert_not_awaited()
            login["uris"] = [{"uri": approved}]
            item_file.write_text(json.dumps(item))
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, request),
                             {"status": "sign_in_blocked"})
            sign_in.assert_awaited_once_with(LOGIN_ITEM, approved, "fixture", "synthetic-site-password",
                                            self.vault.sites[LOGIN_ITEM])

    async def test_read_site_is_scoped_to_hermes_and_approved_recipes(self):
        self.vault.sites = {LOGIN_ITEM: {}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        request = {"read_site": {"item_id": LOGIN_ITEM, "url": None}}
        with patch.object(self.vault.protected_browser, "read", new_callable=AsyncMock,
                          return_value={"status": "ok", "text": "Authenticated"}) as read:
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID + 1, HERMES_UID, request)
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, request),
                             {"status": "ok", "text": "Authenticated"})
            read.assert_awaited_once_with(LOGIN_ITEM, None)

    async def test_totp_code_is_read_only_when_protected_browser_requests_it(self):
        url = "https://www.login.example.com/login"
        profile = self.state / "bw"
        (profile / "login-item.json").write_text(json.dumps({
            "id": LOGIN_ITEM, "type": 1, "login": {
                "username": "fixture-user", "password": "fixture-pw", "totp": "fixture-seed",
                "uris": [{"uri": url}],
            },
        }))
        (profile / "totp-code").write_text("246810")
        self.vault.sites = {LOGIN_ITEM: {"login_url": url, "totp": {}}}
        self.vault.protected_browser = browser.ProtectedBrowser()

        async def approved_prompt(item, saved_url, username, password, recipe, supply_totp):
            self.assertEqual(self.calls(), ["sync", "sync", "unlock", "get"])
            self.assertEqual(await supply_totp(), "246810")
            return "signed_in"

        with patch.object(self.vault.protected_browser, "sign_in", side_effect=approved_prompt):
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, {"login": LOGIN_ITEM}),
                             {"status": "signed_in"})
        self.assertEqual(self.calls(), ["sync", "sync", "unlock", "get", "get"])

    async def test_refuses_console_challenge_requests_from_any_uid(self):
        for uid in (0, HERMES_UID, HERMES_UID + 1):
            for request in ({"totp_challenge": True}, {"finish_totp": {"ticket": "A" * 24, "code": "246810"}}):
                with self.assertRaises(VaultUnavailable):
                    await dispatch(self.vault, uid, HERMES_UID, request)

    async def test_submit_cannot_reach_another_uid_or_unapproved_fields(self):
        self.vault.sites = {LOGIN_ITEM: {"forms": {"save": {
            "fields": {"subject": "#subject"}, "approval": "autonomous",
        }}}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        data = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "fixture draft"}}
        request = {"submit_site": data}
        with patch.object(self.vault.protected_browser, "submit", new_callable=AsyncMock,
                          return_value="submitted") as submit:
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID + 1, HERMES_UID, request)
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, {
                "submit_site": data | {"fields": {"extra": "fixture"}},
            }), {"status": "form_refused"})
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, request),
                             {"status": "submitted"})
            submit.assert_awaited_once_with(LOGIN_ITEM, "save", {"subject": "fixture draft"})

    async def test_direct_submit_requires_root_approval_for_exact_fields_and_consumes_it_once(self):
        form = {"fields": {"subject": "#subject"}}
        self.vault.sites = {LOGIN_ITEM: {"forms": {"save": form, "other": form}}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        data = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "reviewed draft"}}
        approval = {"approve_submit_site": data}
        request = {"submit_site": data}
        with patch.object(self.vault.protected_browser, "submit", new_callable=AsyncMock,
                          return_value="outcome_unknown") as submit:
            with self.assertRaises(VaultUnavailable):
                await dispatch(self.vault, HERMES_UID, HERMES_UID, approval)
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, request),
                             {"status": "approval_required"})
            self.assertEqual(await dispatch(self.vault, 0, HERMES_UID, approval), {"status": "approved"})
            for changed in (data | {"fields": {"subject": "different draft"}}, data | {"form": "other"}):
                self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, {"submit_site": changed}),
                                 {"status": "approval_required"})
            submit.assert_not_awaited()
            replies = await asyncio.gather(*(dispatch(self.vault, HERMES_UID, HERMES_UID, request) for _ in range(2)))
            self.assertCountEqual(replies, [{"status": "outcome_unknown"}, {"status": "approval_required"}])
            submit.assert_awaited_once_with(LOGIN_ITEM, "save", {"subject": "reviewed draft"})

    async def test_approval_expires_and_clears_on_owner_lock(self):
        self.vault.sites = {LOGIN_ITEM: {"forms": {"save": {"fields": {"subject": "#subject"}}}}}
        self.vault.protected_browser = browser.ProtectedBrowser()
        data = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "reviewed draft"}}
        with patch("service.monotonic", side_effect=[1, 301]):
            await dispatch(self.vault, 0, HERMES_UID, {"approve_submit_site": data})
            self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, {"submit_site": data}),
                             {"status": "approval_required"})
        await dispatch(self.vault, 0, HERMES_UID, {"approve_submit_site": data})
        await dispatch(self.vault, 0, HERMES_UID, {"owner_lock": True})
        await dispatch(self.vault, 0, HERMES_UID, {"owner_lock": False})
        self.assertEqual(await dispatch(self.vault, HERMES_UID, HERMES_UID, {"submit_site": data}),
                         {"status": "approval_required"})

    async def test_client_uses_the_local_socket_and_errors_omit_vault_data(self):
        # A short temporary socket path is needed even when macOS sets a long TMPDIR.
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            path = str(Path(directory) / "vault.sock")
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(path)
                listener.listen()
                server = asyncio.create_task(serve(self.vault, listener, HERMES_UID, lambda _: HERMES_UID))
                try:
                    self.assertEqual(await asyncio.to_thread(keys.request, {"keys": [NAME]}, path),
                                     {"keys": {NAME: VALUE}})
                    self.assertEqual(await asyncio.to_thread(keys.request, {"owner_lock": False}, path),
                                     {"error": "unavailable"})
                    self.assertEqual(await asyncio.to_thread(keys.request, {"keys": [VALUE]}, path),
                                     {"error": "unavailable"})
                finally:
                    server.cancel()
                    await asyncio.gather(server, return_exceptions=True)

    async def test_mail_client_disconnect_cancels_the_mail_request(self):
        self.configure_mail()
        approval = object()
        self.vault.submit_approval = approval
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def wait_for_disconnect(*_):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            path = str(Path(directory) / "vault.sock")
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(path)
                listener.listen()
                server = asyncio.create_task(serve(self.vault, listener, HERMES_UID, lambda _: HERMES_UID))
                try:
                    with patch.object(self.vault, "run_mail", side_effect=wait_for_disconnect):
                        async with asyncio.timeout(5):
                            _, writer = await asyncio.open_unix_connection(path)
                            try:
                                writer.write(b'{"mail":{"limit":1}}\n')
                                await writer.drain()
                                await started.wait()
                            finally:
                                writer.close()
                                await writer.wait_closed()
                            await cancelled.wait()
                            self.assertIs(self.vault.submit_approval, approval)
                finally:
                    server.cancel()
                    await asyncio.gather(server, return_exceptions=True)


class ClientTest(unittest.TestCase):
    def test_mail_client_relays_only_pinned_reader_arguments(self):
        message_id = {"uid": 7, "uidvalidity": 91}
        with patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps(message_id).encode()))), \
                patch.object(keys, "request", return_value={"error": "locked"}) as request:
            self.assertEqual(json.loads(keys.respond(["--mail"])), {"status": "locked"})
        request.assert_called_once_with({"mail": message_id}, timeout=42)

    def test_approval_client_reads_exact_submission_from_stdin(self):
        payload = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "reviewed draft"}}
        with patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))), \
                patch.object(keys, "request", return_value={"status": "approved"}) as request:
            self.assertEqual(keys.respond(["--approve-site"]), "approved")
        request.assert_called_once_with({"approve_submit_site": payload})

    def test_login_client_returns_the_blocked_status(self):
        with patch.object(keys, "request", return_value={"status": "sign_in_blocked"}) as request:
            self.assertEqual(keys.respond(["--login", LOGIN_ITEM]), "sign_in_blocked")
        request.assert_called_once_with({"login": LOGIN_ITEM}, timeout=42)

    def test_emits_only_valid_requested_key_lines(self):
        with patch.object(keys, "request", return_value={"keys": {NAME: VALUE}}):
            self.assertEqual(keys.respond([NAME]), f"{NAME}={VALUE}")
        with patch.object(keys, "request", return_value={"keys": {NAME: VALUE + "\nEXTRA=a"}}):
            with self.assertRaises(ValueError):
                keys.respond([NAME])

    def test_site_reader_refuses_extra_response_fields(self):
        arguments = ["--read-site", LOGIN_ITEM]
        with patch.object(keys, "request", return_value={"status": "ok", "text": "Account page"}):
            self.assertEqual(json.loads(keys.respond(arguments)), {"status": "ok", "text": "Account page"})
        with patch.object(keys, "request", return_value={
            "status": "ok", "text": "Account page", "cookies": ["fixture-canary"],
        }):
            with self.assertRaises(ValueError):
                keys.respond(arguments)


class PluginTest(unittest.IsolatedAsyncioTestCase):
    async def test_mail_tool_uses_existing_vault_client_and_defaults_to_listing(self):
        with patch.object(plugin, "_run_client", new_callable=AsyncMock,
                          return_value='{"status": "ok", "uidvalidity": 91, "messages": []}') as client:
            self.assertEqual(json.loads(await plugin.read_mail({})), {
                "status": "ok", "uidvalidity": 91, "messages": [],
            })
        flags, data = client.await_args.args
        self.assertEqual(flags, ["--mail"])
        self.assertEqual(json.loads(data), {"limit": 10})

    async def test_submit_hands_required_approval_back_to_the_owner(self):
        data = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "fake text"}}
        with patch.object(plugin, "_run_client", new_callable=AsyncMock, return_value="approval_required"):
            result = json.loads(await plugin.submit_site(data))
        self.assertEqual(result["status"], "approval_required")
        self.assertIn("Owner", result["next"])

    async def test_submit_pipes_form_values_and_does_not_retry_after_a_lost_reply(self):
        data = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "fake private text"}}
        with patch.object(plugin, "_run_client", new_callable=AsyncMock, return_value="") as client:
            result = json.loads(await plugin.submit_site(data))
        client.assert_awaited_once()
        flags, stdin = client.await_args.args
        self.assertEqual(flags, ["--submit-site"])
        self.assertEqual(json.loads(stdin), data)
        self.assertEqual(result["status"], "outcome_unknown")
        self.assertIn("before retrying", result["next"])

    async def test_blocked_status_has_no_owner_prompt_and_transfer_handoff_omits_private_data(self):
        class Context:
            def register_tool(self, **registration):
                setattr(self, registration["name"], registration)

            def call_mcp(self, server, name, arguments, timeout):
                self.handoff = (server, name, arguments, timeout)

        ctx = Context()
        plugin.register(ctx)
        handler = ctx.quantself_website_sign_in["handler"]
        with patch.object(plugin, "_run_client", new_callable=AsyncMock,
                          side_effect=["sign_in_blocked", "transfer_rejected"]):
            self.assertEqual(json.loads(await handler({"item_id": LOGIN_ITEM})), {"status": "sign_in_blocked"})
            self.assertFalse(hasattr(ctx, "handoff"))
            self.assertEqual(json.loads(await handler({"item_id": LOGIN_ITEM})), {"status": "transfer_rejected"})
        server, name, arguments, _ = ctx.handoff
        self.assertEqual((server, name), ("hq", "ask_user"))
        self.assertNotIn(LOGIN_ITEM, json.dumps(arguments))


if __name__ == "__main__":
    unittest.main()
