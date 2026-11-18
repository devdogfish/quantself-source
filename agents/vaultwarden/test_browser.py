import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shlex
import ssl
import subprocess
import tempfile
from threading import Thread
import unittest
from unittest.mock import AsyncMock, patch

import browser
from cookies import CookieRefused
from service import Vault, dispatch

SAVED = "https://www.login.example.com"
ORIGIN = ("www.login.example.com", 443)
RECIPE = {
    "login_url": SAVED + "/login",
    "verify_url": SAVED + "/account",
    "username_selector": "#user",
    "password_selector": "#password",
    "submit_selector": "#submit",
    "signed_in_selector": "#account",
    "challenge_selectors": ["#otp", "#device"],
    "cookie_names": ["session"],
}
SESSION = {
    "name": "session", "value": "fake-site-session", "path": "/",
    "domain": ORIGIN[0], "secure": True, "httpOnly": True,
    "sameSite": "Strict", "session": True, "expires": -1,
    "sourceScheme": "Secure", "sourcePort": 443,
}


class RecipeTest(unittest.TestCase):
    def test_login_and_verification_require_saved_https_origin(self):
        browser.validate_recipe(SAVED, RECIPE)
        for url in ("http://www.login.example.com", SAVED + ":444", "https://example.com",
                    "https://www.login.example.com.example.org"):
            with self.subTest(url=url), self.assertRaises(CookieRefused):
                browser.validate_recipe(SAVED, RECIPE | {"verify_url": url})
        with self.assertRaises(ValueError):
            browser.validate_recipe(SAVED, RECIPE | {"cookie_names": []})

    def test_site_form_must_pin_a_same_origin_action(self):
        form = {"url": SAVED + "/compose", "action_url": SAVED + "/draft",
                "submit_selector": "#save", "fields": {"subject": "#subject"}, "success_selector": "#saved"}
        browser.validate_recipe(SAVED, RECIPE | {"forms": {"save_draft": form}})
        with self.assertRaises(ValueError):
            browser.validate_recipe(SAVED, RECIPE | {"forms": {
                "save_draft": form | {"action_url": "https://other.example.org/draft"},
            }})
        with self.assertRaises(ValueError):
            browser.validate_recipe(SAVED, RECIPE | {"forms": {"save_draft": form | {"approval": False}}})

    def test_only_explicitly_approved_cookie_names_are_transferred(self):
        extra = SESSION | {"name": "analytics"}
        [(cookie, params)] = browser._session_params([SESSION, extra], RECIPE, SAVED)
        self.assertEqual(cookie, SESSION)
        self.assertNotIn("domain", params)
        self.assertTrue(params["httpOnly"])
        for invalid in (SESSION | {"secure": False}, SESSION | {"domain": "wrong.example.org"}):
            with self.assertRaises(browser.LoginHandoff) as caught:
                browser._session_params([invalid], RECIPE, SAVED)
            self.assertEqual(caught.exception.status, "transfer_rejected")


class FakeCDP:
    def __init__(self, cookies=()):
        self.cookies = list(cookies)
        self.calls = []
        self.handlers = {}

    def on(self, event, handler):
        self.handlers[event] = handler

    async def send(self, name, params=None, **_):
        self.calls.append((name, params))
        if name == "Network.getCookies":
            return {"cookies": self.cookies.copy()}
        if name == "Network.setCookies":
            for param in params["cookies"]:
                cookie = SESSION | {key: value for key, value in param.items() if key != "url"}
                identity = browser._cookie_identity(cookie)
                self.cookies = [prior for prior in self.cookies if browser._cookie_identity(prior) != identity]
                self.cookies.append(cookie)
        if name == "Network.deleteCookies":
            self.cookies = [cookie for cookie in self.cookies if not all(
                cookie.get(field) == value for field, value in params.items())]


class BrowserTest(unittest.IsolatedAsyncioTestCase):
    async def test_network_guard_refuses_cross_origin_redirect_before_continuing(self):
        cdp = FakeCDP()
        boundary = browser.OriginBoundary(cdp, ORIGIN, main_frame_id="main")
        boundary.check_request({
            "requestId": "form", "request": {"url": SAVED + "/login"},
            "resourceType": "Document", "frameId": "main",
        })
        boundary.check_request({
            "requestId": "redirect", "redirectedRequestId": "form",
            "request": {"url": "https://example.org/auth"}, "resourceType": "Document", "frameId": "main",
        })
        await asyncio.gather(*boundary.tasks)
        self.assertTrue(boundary.refused)
        self.assertEqual(cdp.calls, [
            ("Fetch.continueRequest", {"requestId": "form"}),
            ("Fetch.failRequest", {"requestId": "redirect", "errorReason": "BlockedByClient"}),
        ])

    async def test_form_network_policy_allows_one_exact_post(self):
        cdp = FakeCDP()
        boundary = browser.OriginBoundary(cdp, ORIGIN, main_frame_id="main")
        boundary.post_url = SAVED + "/draft"
        boundary.check_request({"requestId": "embedded", "resourceType": "Document", "frameId": "child",
                                "request": {"url": boundary.post_url, "method": "POST"}})
        for name, url in (("write", boundary.post_url), ("redirect", SAVED + "/send"),
                          ("repeat", boundary.post_url)):
            boundary.check_request({"requestId": name, "resourceType": "Document",
                                    "frameId": "main",
                                    "request": {"url": url, "method": "POST"}})
        await asyncio.gather(*boundary.tasks)
        self.assertTrue(boundary.posted)
        self.assertEqual([method for method, _ in cdp.calls],
                         ["Fetch.failRequest", "Fetch.continueRequest", "Fetch.failRequest", "Fetch.failRequest"])

    async def test_cookie_tracking_uses_unfiltered_network_metadata(self):
        cdp = FakeCDP()
        values = set()
        boundary = browser.OriginBoundary(cdp, ORIGIN, values)
        await boundary.arm()
        cdp.handlers["Network.requestWillBeSentExtraInfo"]({
            "associatedCookies": [{"cookie": {"value": "previous-cookie"}}],
        })
        cdp.handlers["Network.responseReceivedExtraInfo"]({
            "headers": {"SeT-CoOkIe": 'rotated="synthetic-cookie"; Path=/private; HttpOnly\nexpired=; Max-Age=0'},
        })
        self.assertIn(("Network.enable", None), cdp.calls)
        self.assertEqual(values, {"previous-cookie", '"synthetic-cookie"', "synthetic-cookie"})

    async def test_never_fills_credentials_when_challenge_is_already_visible(self):
        class Page:
            evaluate = AsyncMock()

            def locator(self, selector):
                self.selector = selector
                return self

            async def is_visible(self):
                return self.selector == "#device"

        page = Page()
        with (patch.object(browser, "_visit", return_value=True),
              self.assertRaises(browser.LoginHandoff) as caught):
            await browser._submit(page, None, SAVED, "fixture-user", "fixture-password", RECIPE)
        self.assertEqual(caught.exception.status, "sign_in_blocked")
        page.evaluate.assert_not_awaited()

    async def exercise_handoff(self, prior, authenticated):
        cdp = FakeCDP(prior)

        @asynccontextmanager
        async def controlled_page(*_):
            yield None, cdp, None

        candidates = browser._session_params([SESSION], RECIPE, SAVED)
        with (patch.object(browser, "controlled_page", controlled_page),
              patch.object(browser, "_authenticated", return_value=authenticated)):
            result = await browser._handoff(None, ORIGIN, RECIPE, candidates)
        return result, cdp

    async def test_verified_transfer_preserves_the_session(self):
        status, cdp = await self.exercise_handoff([], True)
        self.assertEqual(status, "signed_in")
        self.assertEqual(cdp.cookies, [SESSION])

    async def test_rejected_transfer_deletes_only_the_attempts_cookies(self):
        prior = SESSION | {"name": "existing"}
        status, cdp = await self.exercise_handoff([prior], False)
        self.assertEqual(status, "transfer_rejected")
        self.assertEqual(cdp.cookies, [prior])
        self.assertIn(("Network.deleteCookies", {
            "name": SESSION["name"], "domain": SESSION["domain"], "path": SESSION["path"],
        }), cdp.calls)

    async def test_rejected_replacement_restores_previous_session(self):
        prior = SESSION | {"value": "already-in-browser"}
        status, cdp = await self.exercise_handoff([prior], False)
        self.assertEqual(status, "transfer_rejected")
        self.assertEqual(cdp.cookies, [prior])
        self.assertEqual([call for call, _ in cdp.calls].count("Network.setCookies"), 2)

    async def test_verified_replacement_keeps_new_session(self):
        prior = SESSION | {"value": "already-in-browser"}
        status, cdp = await self.exercise_handoff([prior], True)
        self.assertEqual(status, "signed_in")
        self.assertEqual(cdp.cookies, [SESSION])

    async def test_ambiguous_cookie_identity_preserves_existing_session(self):
        prior = SESSION | {"value": "already-in-browser", "sourcePort": 444}
        status, cdp = await self.exercise_handoff([prior], True)
        self.assertEqual(status, "transfer_rejected")
        self.assertEqual(cdp.cookies, [prior])
        self.assertEqual(cdp.calls, [("Network.getCookies", {"urls": [RECIPE["login_url"], RECIPE["verify_url"]]})])

    async def test_a_second_cancel_does_not_interrupt_rollback(self):
        started = asyncio.Event()
        complete = asyncio.Event()

        async def cleanup():
            started.set()
            await complete.wait()

        rollback = asyncio.create_task(browser._complete_rollback([cleanup()]))
        await started.wait()
        rollback.cancel()
        await asyncio.sleep(0)
        rollback.cancel()
        await asyncio.sleep(0)
        self.assertFalse(rollback.done())
        complete.set()
        with self.assertRaises(asyncio.CancelledError):
            await rollback


class ProtectedBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_stays_on_origin_and_masks_original_and_rotated_cookies(self):
        protected = browser.ProtectedBrowser()
        context = AsyncMock()
        context.cookies.side_effect = [
            [SESSION | {"value": "deleted-cookie"}],
            [SESSION | {"value": "rotated-cookie"}],
        ]
        protected.sessions["item"] = (context, ORIGIN, RECIPE, {"old-cookie"})
        page = AsyncMock()
        page.locator = lambda _: page
        page.inner_text.return_value = "Account page old-cookie rotated-cookie deleted-cookie transient-cookie"
        cdp = FakeCDP([SESSION | {"value": "rotated-cookie"}])
        boundary = AsyncMock()
        boundary.verify = lambda _: None

        @asynccontextmanager
        async def page_fixture(actual_context, origin, values):
            self.assertIs(actual_context, context)
            self.assertEqual(origin, ORIGIN)
            values.add("transient-cookie")
            yield page, cdp, boundary

        with patch.object(browser, "controlled_page", page_fixture), \
                patch.object(browser, "_visit", new_callable=AsyncMock, return_value=True) as visit:
            self.assertEqual(await protected.read("missing", None), {"status": "sign_in_required"})
            self.assertEqual(await protected.read("item", "https://different.example.org/"),
                             {"status": "origin_refused"})
            visit.assert_not_awaited()
            self.assertEqual(await protected.read("item", None), {
                "status": "ok", "text": "Account page [redacted] [redacted] [redacted] [redacted]",
            })

    async def test_effective_login_uses_only_service_owned_contexts(self):
        protected = browser.ProtectedBrowser()
        private, destination = AsyncMock(), AsyncMock()
        cdp = FakeCDP([SESSION])
        boundary = AsyncMock()
        boundary.verify = lambda _: None

        @asynccontextmanager
        async def private_page(context, origin, _values):
            self.assertIs(context, private)
            self.assertEqual(origin, ORIGIN)
            yield object(), cdp, boundary

        with patch.object(protected, "_context", new_callable=AsyncMock,
                          side_effect=[private, destination]), \
                patch.object(browser, "controlled_page", private_page), \
                patch.object(browser, "_submit", new_callable=AsyncMock), \
                patch.object(browser, "_handoff", new_callable=AsyncMock, return_value="signed_in") as handoff:
            self.assertEqual(await protected.sign_in("item", SAVED, "fake-user", "fake-password", RECIPE),
                             "signed_in")
            handoff.assert_awaited_once()
            self.assertIs(handoff.await_args.args[0], destination)
            self.assertIs(protected.sessions["item"][0], destination)
            private.close.assert_awaited_once()
            destination.close.assert_not_awaited()

@unittest.skipUnless(os.environ.get("VAULTWARDEN_TEST_CHROMIUM"), "Set VAULTWARDEN_TEST_CHROMIUM for the local HTTPS fixture")
class ChromiumTest(unittest.IsolatedAsyncioTestCase):
    async def test_domain_cookie_handoff_and_cross_origin_redirect_refusal(self):
        hits = []
        draft_writes = []
        totp_posts = []

        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body=b"", headers=()):
                self.send_response(status)
                for name, value in headers:
                    self.send_header(name, value)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                hits.append((self.headers["Host"], self.path))
                if self.path.startswith("/login"):
                    _, query, behavior = self.path.partition("?")
                    suffix = query + behavior if behavior in {"redirect", "challenge", "replace", "totp", "totp-cross"} else ""
                    self.reply(200, (
                        '<form method="post" action="/session' + suffix + '">'
                        '<input id="user" name="user"><input id="password" name="password" type="password">'
                        '<button id="submit" type="submit">Sign in</button></form>'
                    ).encode())
                elif self.path == "/challenge":
                    self.reply(200, b'<input id="otp" name="otp">')
                elif self.path.startswith("/challenge/totp"):
                    target = (f"https://www.wrong.example.org:{self.server.server_port}/verify-totp"
                              if self.path.endswith("?cross") else "/verify-totp")
                    self.reply(200, (f'<form method="post" action="{target}">'
                                     '<input id="otp" name="otp" autocomplete="one-time-code" required>'
                                     '<button id="verify" type="submit">Verify</button></form>').encode())
                elif self.path == "/account/confirmation" and "session=fixture" in self.headers.get("Cookie", ""):
                    self.reply(200, b'<p id="account">fixture-password 246810</p>')
                elif self.path == "/account/redirect" and "session=fixture" in self.headers.get("Cookie", ""):
                    self.reply(302, headers=[
                        ("Set-Cookie", "rotated=fixture-rotated; Path=/private; Secure; HttpOnly"),
                        ("Location", "/private/view"),
                    ])
                elif self.path == "/private/view":
                    cookie = self.headers.get("Cookie", "")
                    if "rotated=fixture-rotated" in cookie:
                        self.reply(200, b"<p>rotated=fixture-rotated</p>")
                    else:
                        self.reply(401)
                elif self.path == "/account/transient":
                    self.reply(302, headers=[
                        ("Set-Cookie", "transient=synthetic-transient-cookie; Path=/private; Secure; HttpOnly"),
                        ("Location", "/private/consume"),
                    ])
                elif self.path == "/private/consume":
                    if "transient=synthetic-transient-cookie" in self.headers.get("Cookie", ""):
                        self.reply(200, b"<p>transient=synthetic-transient-cookie</p>", headers=[
                            ("Set-Cookie", "transient=; Max-Age=0; Path=/private; Secure; HttpOnly"),
                        ])
                    else:
                        self.reply(401)
                elif self.path.startswith("/compose") and "session=fixture" in self.headers.get("Cookie", ""):
                    mode = self.path.partition("?")[2]
                    action = {
                        "cross": f"https://www.wrong.example.org:{self.server.server_port}/draft",
                        "alternate": "/send",
                        "uncertain": "/draft?uncertain",
                    }.get(mode, "/draft")
                    challenge = '<input name="confirmation" autocomplete="one-time-code">' if mode == "otp" else ""
                    self.reply(200, (
                        f'<form method="post" action="{action}">'
                        '<input name="subject" id="subject" required>'
                        '<input name="csrf_token" type="hidden" value="fixture-csrf">'
                        f'{challenge}<button id="save" type="submit">Save</button></form>'
                    ).encode())
                elif self.path == "/saved":
                    self.reply(200, b'<p id="saved">Saved</p>')
                elif "session=fixture" in self.headers.get("Cookie", ""):
                    self.reply(200, b'<p id="account">Authenticated fixture</p>')
                else:
                    self.reply(401)

            def do_POST(self):
                hits.append((self.headers["Host"], self.path))
                data = self.rfile.read(int(self.headers["Content-Length"]))
                cookie = "session=fixture; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=Strict"
                if self.path == "/verify-totp":
                    totp_posts.append(data)
                    if data == b"otp=246810" and "preauth=browser-only" in self.headers.get("Cookie", ""):
                        self.reply(303, headers=[("Set-Cookie", cookie), ("Location", "/account")])
                    else:
                        self.reply(401)
                    return
                if self.path.startswith("/draft") or self.path == "/send":
                    draft_writes.append((self.path, data))
                    if self.path == "/draft?uncertain":
                        self.reply(307, headers=[("Location", "/draft/retry")])
                    else:
                        self.reply(303, headers=[("Location", "/saved")])
                    return
                if data != b"user=fixture-user&password=fixture-password":
                    self.reply(401)
                elif self.path.endswith("?redirect"):
                    port = self.server.server_port
                    self.reply(307, headers=[("Location", f"https://www.wrong.example.org:{port}/wrong")])
                elif self.path.endswith("?challenge"):
                    self.reply(303, headers=[("Location", "/challenge")])
                elif self.path.endswith(("?totp", "?totp-cross")):
                    suffix = "?cross" if self.path.endswith("?totp-cross") else ""
                    self.reply(303, headers=[("Set-Cookie", "preauth=browser-only; Secure; HttpOnly; SameSite=Strict"),
                                             ("Location", "/challenge/totp" + suffix)])
                else:
                    session = "fixture-replacement" if self.path.endswith("?replace") else "fixture"
                    cookie = f"session={session}; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=Strict"
                    self.reply(303, headers=[("Set-Cookie", cookie), ("Location", "/account")])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cert = root / "cert.pem"
            key = root / "key.pem"
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=www.login.example.com",
                "-addext", "subjectAltName=DNS:www.login.example.com,DNS:www.wrong.example.org",
                "-keyout", key, "-out", cert,
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            pubkey = subprocess.check_output(["openssl", "x509", "-pubkey", "-noout", "-in", cert])
            spki = subprocess.check_output(["openssl", "pkey", "-pubin", "-outform", "DER"], input=pubkey)
            pin = base64.b64encode(hashlib.sha256(spki).digest()).decode()
            web_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            web_tls.load_cert_chain(cert, key)
            with ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
                server.socket = web_tls.wrap_socket(server.socket, server_side=True)
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                port = server.server_port
                origin = f"https://www.login.example.com:{port}"
                rule = "MAP www.login.example.com 127.0.0.1, MAP www.wrong.example.org 127.0.0.1"
                chromium = os.environ["VAULTWARDEN_TEST_CHROMIUM"]
                flags = [
                    "--enable-automation", "--no-proxy-server", f"--host-resolver-rules={rule}",
                    f"--ignore-certificate-errors-spki-list={pin}",
                ]
                launcher = root / "fixture-chromium"
                launcher.write_text("#!/bin/sh\nexec " + shlex.join([chromium, *flags]) + ' "$@"\n')
                launcher.chmod(0o700)
                protected = browser.ProtectedBrowser()
                vault = Vault("unused", root, root / "unused", "00000000-0000-0000-0000-000000000000",
                    protected_browser=protected)
                try:
                    form = {"action_url": origin + "/draft", "submit_selector": "#save",
                            "fields": {"subject": "#subject"}, "success_selector": "#saved"}
                    forms = {name: form | {"url": origin + "/compose?" + name}
                             for name in ("save", "cross", "alternate", "otp", "uncertain")}
                    forms["uncertain"]["action_url"] += "?uncertain"
                    recipe = RECIPE | {"login_url": origin + "/login", "verify_url": origin + "/account", "forms": forms}
                    with patch.object(browser, "CHROMIUM", str(launcher)), \
                            patch.object(browser, "NAVIGATION_TIMEOUT", 10000):
                        denied = await protected.sign_in(
                            "item", origin, "fixture-user", "fixture-password",
                            recipe | {"login_url": origin + "/login?redirect"},
                        )
                        self.assertEqual(denied, "origin_refused")
                        self.assertFalse(any(host.startswith("www.wrong.example.org") for host, _ in hits))
                        self.assertEqual(await protected.sign_in(
                            "item", origin, "fixture-user", "fixture-password",
                            recipe | {"login_url": origin + "/login?challenge"},
                        ), "sign_in_blocked")
                        self.assertEqual(await protected.sign_in(
                            "item", origin, "fixture-user", "fixture-password", recipe,
                        ), "signed_in")
                        totp_recipe = recipe | {"login_url": origin + "/login?totp", "totp": {
                            "url": origin + "/challenge/totp", "action_url": origin + "/verify-totp",
                            "code_selector": "#otp", "submit_selector": "#verify",
                        }}
                        supplier = AsyncMock(return_value="246810")
                        self.assertEqual(await protected.sign_in(
                            "auto-totp", origin, "fixture-user", "fixture-password", totp_recipe, supplier,
                        ), "signed_in")
                        supplier.assert_awaited_once()
                        self.assertEqual(await protected.read("auto-totp", origin + "/account/confirmation"), {
                            "status": "ok", "text": "[redacted] [redacted]",
                            "forms": {name: ["subject"] for name in forms},
                        })
                        active_contexts = protected.browser.contexts
                        for code, posts in ((None, [b"otp=246810"]), ("invalid", [b"otp=246810"]),
                                            ("111111", [b"otp=246810", b"otp=111111"])):
                            with self.subTest(code=code):
                                unavailable_code = AsyncMock(return_value=code)
                                self.assertEqual(await protected.sign_in(
                                    "blocked-totp", origin, "fixture-user", "fixture-password",
                                    totp_recipe, unavailable_code,
                                ), "sign_in_blocked")
                                unavailable_code.assert_awaited_once()
                                self.assertEqual(await protected.read("blocked-totp", None),
                                                 {"status": "sign_in_required"})
                                self.assertEqual(protected.browser.contexts, active_contexts)
                                self.assertEqual(totp_posts, posts)
                        cross = totp_recipe | {"login_url": origin + "/login?totp-cross",
                                               "totp": totp_recipe["totp"] | {"url": origin + "/challenge/totp?cross"}}
                        self.assertEqual(await protected.sign_in(
                            "cross-totp", origin, "fixture-user", "fixture-password", cross, supplier,
                        ), "origin_refused")
                        self.assertEqual(totp_posts, [b"otp=246810", b"otp=111111"])
                        self.assertFalse(any(host.startswith("www.wrong.example.org") for host, _ in hits))
                    self.assertEqual(await protected.read("item", None), {
                        "status": "ok", "text": "Authenticated [redacted]",
                        "forms": {name: ["subject"] for name in forms},
                    })
                    fields = {"subject": "fixture draft"}
                    self.assertEqual(await protected.submit("item", "missing", fields), "form_refused")
                    self.assertEqual(await protected.submit("item", "cross", fields), "origin_refused")
                    self.assertEqual(await protected.submit("item", "alternate", fields), "form_refused")
                    self.assertEqual(await protected.submit("item", "otp", fields), "form_refused")
                    vault.sites = {"item": recipe}
                    submit = {"item_id": "item", "form": "save", "fields": fields}
                    request = {"submit_site": submit}
                    self.assertEqual(await dispatch(vault, 1234, 1234, request), {"status": "approval_required"})
                    self.assertEqual(draft_writes, [])
                    self.assertEqual(await dispatch(vault, 0, 1234, {"approve_submit_site": submit}), {"status": "approved"})
                    self.assertEqual(await dispatch(vault, 1234, 1234, request), {"status": "submitted"})
                    self.assertEqual(await dispatch(vault, 1234, 1234, request), {"status": "approval_required"})
                    self.assertEqual(await protected.submit("item", "uncertain", fields), "outcome_unknown")
                    self.assertEqual(draft_writes, [
                        ("/draft", b"subject=fixture+draft&csrf_token=fixture-csrf"),
                        ("/draft?uncertain", b"subject=fixture+draft&csrf_token=fixture-csrf"),
                    ])
                    session = await protected.browser.new_browser_cdp_session()
                    args = (await session.send("Browser.getBrowserCommandLine"))["arguments"]
                    self.assertIn("--remote-debugging-pipe", args)
                    self.assertFalse(any(arg.startswith("--remote-debugging-port") for arg in args))
                    cookies = await protected.sessions["item"][0].cookies()
                    self.assertEqual(len(cookies), 1)
                    self.assertEqual(cookies[0]["domain"], ".example.com")
                    self.assertTrue(cookies[0]["secure"] and cookies[0]["httpOnly"])
                    self.assertEqual(await protected.read("item", origin + "/account/redirect"), {
                        "status": "ok", "text": "rotated=[redacted]",
                        "forms": {name: ["subject"] for name in forms},
                    })
                    self.assertEqual(await protected.read("item", origin + "/account/transient"), {
                        "status": "ok", "text": "transient=[redacted]",
                        "forms": {name: ["subject"] for name in forms},
                    })
                    disconnected = asyncio.Event()
                    protected.browser.on("disconnected", lambda _: disconnected.set())
                    vault.idle_seconds = 0.01
                    async with vault.operation(vault.browser_serial):
                        self.assertTrue(protected.browser.is_connected())
                    async with asyncio.timeout(5):
                        await disconnected.wait()
                    self.assertEqual(await protected.read("item", None), {"status": "sign_in_required"})
                finally:
                    await vault.close()
                    server.shutdown()
                    thread.join(timeout=2)



if __name__ == "__main__":
    unittest.main()
