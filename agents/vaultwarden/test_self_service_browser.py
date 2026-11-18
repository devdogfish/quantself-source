import asyncio
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs

import browser
from cookies import CookieRefused, https_origin
from origin_proxy import PinnedOriginProxy
from self_service_browser import SITE_BROWSER_ARGS, Site, open_site, redact, valid_seed


class PublicOriginTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_private_and_mixed_dns_results(self):
        getaddrinfo = asyncio.get_running_loop().getaddrinfo

        def answer(address):
            return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))

        for addresses in (["100.64.0.1"], ["8.8.8.8", "127.0.0.1"], ["192.168.0.5"], []):
            lookup = AsyncMock(return_value=[answer(address) for address in addresses])
            with self.subTest(addresses=addresses), patch.object(asyncio.get_running_loop(), "getaddrinfo", lookup):
                with self.assertRaises(CookieRefused):
                    await open_site("https://example.org/login")
        self.assertEqual(asyncio.get_running_loop().getaddrinfo, getaddrinfo)

    async def test_pins_checked_address_with_no_fallback(self):
        lookup = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))])
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", lookup):
            site = await open_site("https://example.org/login")
        self.assertEqual(site.browser.origin_proxy.authority, b"example.org:443")
        self.assertEqual(site.browser.origin_proxy.address, ip_address("8.8.8.8"))
        self.assertNotIn("--no-proxy-server", site.browser.launch_args)


class SecretTest(unittest.TestCase):
    def test_otp_enrollment_seed_must_be_for_this_account(self):
        uri = "otpauth://totp/Fixture:tyler?secret=JBSWY3DPEHPK3PXP&issuer=Fixture"
        self.assertEqual(valid_seed(uri, "tyler", None), uri)
        self.assertIsNone(valid_seed(uri, "sam", None))
        self.assertIsNone(valid_seed(uri + "&secret=JBSWY3DPEHPK3PXP", "tyler", None))
        self.assertIsNone(valid_seed(uri + "&period=60", "tyler", None))

    def test_redacts_literal_and_encoded_session_values(self):
        fake_value = "fixture-cookie+/="
        raw = fake_value.encode()
        display = f"{fake_value} {raw.hex()} {base64.b64encode(raw).decode()} {base64.urlsafe_b64encode(raw).decode()}"
        rendered = redact(display, {fake_value})
        for token in display.split():
            self.assertNotIn(token, rendered)
        self.assertEqual(rendered.count("[redacted]"), 4)


class NativeLifecycleTest(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(os.environ.get("VAULTWARDEN_TEST_CHROMIUM"), "requires fixture Chromium")
    async def test_signup_verify_signout_reopen_and_scripted_login(self):
        host = "self-service.example.org"
        password = "fixture-generated-password"
        cookie = "fixture-accepted-cookie"
        seed = "otpauth://totp/Fixture:tyler?secret=JBSWY3DPEHPK3PXP&issuer=Fixture"
        posts = []
        foreign_hits = []
        signup = (
            '<form method="post" action="/login"><input type="hidden" name="creating" value="t">'
            '<input type="hidden" name="action" value="fixture"><input type="hidden" name="elements" value="fixture">'
            '<input name="acct"><label>Email (optional)<input type="email" name="email"></label>'
            '<input type="password" name="pw"><input type="submit" value="Create Account"></form>'
        )
        login = (
            '<form method="post" action="/login"><input name="acct"><input type="password" name="pw">'
            '<input type="submit" value="Login"></form>'
        )
        challenge = (
            '<form method="post"><input name="code" autocomplete="one-time-code" required>'
            '<button type="submit">Verify</button></form>'
        )

        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body="", headers=()):
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                for name, value in headers:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body.encode())

            def do_GET(self):
                if self.path.startswith("/foreign-") or self.path == "/iframe":
                    foreign_hits.append(self.path)
                    self.reply(200)
                elif self.path in {"/login?scripted", "/login?tampered"}:
                    foreign = f"https://other.example.org:{self.server.server_port}"
                    loopback = f"https://127.0.0.1:{self.server.server_port}"
                    tamper = "event.formData.append('pw', 'forged');" if self.path.endswith("tampered") else ""
                    self.reply(200, f"""<script>
                        document.addEventListener('DOMContentLoaded', () => {{
                            document.body.innerHTML = {json.dumps(login)};
                            document.querySelector('form').addEventListener('formdata', event => {{
                                localStorage.setItem('fixture-observed', event.formData.get('pw') || '');
                                {tamper}
                            }});
                            fetch({json.dumps(foreign + '/foreign-fetch')}).catch(() => {{}});
                            fetch({json.dumps(loopback + '/foreign-private-ip')}).catch(() => {{}});
                            window.open({json.dumps(foreign + '/foreign-popup')});
                            new WebSocket('wss://' + location.host + '/foreign-websocket');
                        }});
                    </script>""")
                elif self.path.startswith("/login"):
                    native_signup = signup
                    if "cross" in self.path:
                        native_signup = signup.replace(
                            'action="/login"', f'action="https://other.example.org:{self.server.server_port}/login"')
                    if "redirect" in self.path:
                        native_signup = signup.replace('action="/login"', 'action="/signup-redirect"')
                    if "embed" in self.path:
                        native_signup += f'<iframe src="https://other.example.org:{self.server.server_port}/iframe"></iframe>'
                    self.reply(200, login + native_signup + (signup if "ambiguous" in self.path else ""))
                elif self.path == "/verify-email":
                    self.reply(200, "<p>We emailed your verification code</p>" + challenge)
                elif self.path == "/verify-totp":
                    self.reply(200, f'<a href="{seed}">Add authenticator</a>' + challenge)
                elif self.path.startswith("/logout"):
                    self.reply(303, headers=(("Set-Cookie", "session=; Max-Age=0; Path=/; Secure; HttpOnly"),
                                            ("Location", "/login")))
                elif self.path == "/account" and f"session={cookie}" in self.headers.get("Cookie", ""):
                    encoded = base64.b64encode(cookie.encode()).decode()
                    logout = (
                        '<nav><ul><li>Account<ul style="display:none">'
                        '<li><a href="/logout?auth=fixture"><i>exit_icon</i> Log out</a></li>'
                        '<li hidden><a href="/logout?auth=decoy">Log out</a></li>'
                        '</ul></li></ul></nav>'
                    )
                    self.reply(200, f"""{logout}<p>{password} {encoded}</p><script>
                        localStorage.setItem('fixture-account-script-ran', 'yes');
                        document.body.append('Script-only account text');
                    </script>""")
                else:
                    self.reply(404)

            def do_POST(self):
                fields = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
                posts.append((self.path, fields))
                if self.path == "/login" and fields.get("pw") == [password]:
                    if fields.get("creating") == ["t"]:
                        self.reply(303, headers=(("Location", "/verify-email"),))
                    else:
                        self.authenticated()
                elif self.path == "/verify-email" and fields.get("code") == ["123456"]:
                    self.reply(303, headers=(("Location", "/verify-totp"),))
                elif self.path == "/verify-totp" and fields.get("code") == ["654321"]:
                    self.authenticated()
                elif self.path == "/signup-redirect":
                    self.reply(307, headers=(("Location", "/login"),))
                else:
                    self.reply(403)

            def authenticated(self):
                self.reply(303, headers=(("Set-Cookie", f"session={cookie}; Path=/; Secure; HttpOnly"),
                                        ("Location", "/account")))

        with TemporaryDirectory() as temp:
            cert, key = Path(temp) / "cert.pem", Path(temp) / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", f"/CN={host}", "-addext", f"subjectAltName=DNS:{host}",
                            "-keyout", key, "-out", cert], check=True, capture_output=True)
            pubkey = subprocess.check_output(["openssl", "x509", "-pubkey", "-noout", "-in", cert])
            spki = subprocess.check_output(["openssl", "pkey", "-pubin", "-outform", "DER"], input=pubkey)
            pin = base64.b64encode(hashlib.sha256(spki).digest()).decode()
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            with ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
                server.socket = tls.wrap_socket(server.socket, server_side=True)
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = f"https://{host}:{server.server_port}/login"
                origin = https_origin(url)
                protected = browser.ProtectedBrowser((
                    *SITE_BROWSER_ARGS,
                    f"--ignore-certificate-errors-spki-list={pin}",
                ), origin_proxy=PinnedOriginProxy(origin, "127.0.0.1"))
                site = Site(url + "?embed", origin, protected)
                journal = AsyncMock()
                try:
                    with patch.object(browser, "CHROMIUM", os.environ["VAULTWARDEN_TEST_CHROMIUM"]):
                        ambiguous = Site(url + "?ambiguous", origin, protected)
                        self.assertEqual(await ambiguous.start("signup", "tyler", password, None, journal),
                                         "unsupported")
                        journal.assert_not_awaited()
                        self.assertEqual(posts, [])
                        cross = Site(url + "?cross", origin, protected)
                        self.assertEqual(await cross.start("signup", "tyler", password, None, journal), "unsupported")
                        journal.assert_not_awaited()
                        self.assertEqual(posts, [])
                        redirected = Site(url + "?redirect", origin, protected)
                        self.assertEqual(await redirected.start("signup", "tyler", password, None, journal),
                                         "origin_refused")
                        journal.assert_awaited_once()
                        self.assertEqual([path for path, _ in posts], ["/signup-redirect"])
                        posts.clear()
                        journal.reset_mock()
                        self.assertEqual(await site.start("signup", "tyler", password, None, journal),
                                         "email_verification_required")
                        journal.assert_awaited_once()
                        self.assertEqual(await site.code("123456"), "totp_setup_required")
                        self.assertEqual(await site.totp_seed("tyler", None), seed)
                        self.assertEqual(await site.code("654321"), "signed_in")
                        self.assertEqual(await site.code("654321"), "unsupported")
                        read = await site.read(None)
                        self.assertEqual(read["status"], "ok")
                        self.assertEqual(read["text"].split(), ["Account", "[redacted]", "[redacted]"])
                        self.assertEqual(await site.sign_out(), "signed_out")
                        self.assertEqual(await site.reopen(), "signed_out")
                        scripted = Site(url + "?scripted", origin, protected)
                        try:
                            self.assertEqual(await scripted.start("sign_in", "tyler", password, None), "signed_in")
                            origins = (await scripted.context.storage_state())["origins"]
                            storage = {item["name"]: item["value"] for saved in origins
                                       for item in saved["localStorage"]}
                            self.assertEqual(storage["fixture-account-script-ran"], "yes")
                            self.assertTrue(storage["fixture-observed"])
                            self.assertNotIn(password, storage["fixture-observed"])
                            self.assertEqual(await scripted.read(None), read)
                        finally:
                            await scripted.close()
                        tampered = Site(url + "?tampered", origin, protected)
                        try:
                            self.assertNotEqual(await tampered.start("sign_in", "tyler", password, None), "signed_in")
                        finally:
                            await tampered.close()
                    self.assertEqual([path for path, _ in posts], ["/login", "/verify-email", "/verify-totp", "/login"])
                    self.assertEqual(posts[0][1]["creating"], ["t"])
                    self.assertNotIn("email", posts[0][1])
                    self.assertEqual(posts[-1][1], {"acct": ["tyler"], "pw": [password]})
                    self.assertEqual(foreign_hits, [])
                finally:
                    await site.close()
                    server.shutdown()
                    thread.join(timeout=2)
