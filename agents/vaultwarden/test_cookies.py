import unittest
from unittest.mock import patch

import cookies


SAVED_URL = "https://www.login.example.com/sign-in"
COOKIE = {
    "name": "fake-session",
    "value": "fake-session-value",
    "domain": "www.login.example.com",
    "path": "/account",
    "expires": -1,
    "size": 30,
    "httpOnly": True,
    "secure": True,
    "session": True,
    "sameSite": "Strict",
    "priority": "High",
    "sourceScheme": "Secure",
    "sourcePort": 443,
}


class OriginTest(unittest.TestCase):
    def test_effective_port_and_canonical_host(self):
        self.assertEqual(cookies.https_origin("https://WWW.Example.com/x"), ("www.example.com", 443))
        self.assertEqual(cookies.https_origin("https://www.example.com:8443/y"), ("www.example.com", 8443))
        self.assertEqual(cookies.https_origin("https://[2001:DB8::1]:443/x"), ("2001:db8::1", 443))

    def test_refuses_ambiguous_or_insecure_origin(self):
        for url in (
            "http://example.com/", "https://user@example.com/", "https://example.com./",
            "https://example.com:0/", "https://example.com:65536/", "https://example.com:/",
            "https://example.com\\@other.test/", "https://%65xample.com/", "https://[::1]example.com/",
            "https://www.exa\nmple.com/", "https://0177.0.0.1/", "https://127.1/", "https://0x7f000001/",
        ):
            with self.subTest(url=url), self.assertRaises(cookies.CookieRefused):
                cookies.https_origin(url)


class CookieTest(unittest.TestCase):
    def test_host_only_session_keeps_path_and_security_attributes(self):
        params = cookies.cookie_params(COOKIE, SAVED_URL)
        self.assertEqual(params, {
            "name": COOKIE["name"], "value": COOKIE["value"], "url": "https://www.login.example.com/",
            "path": "/account", "secure": True, "httpOnly": True, "sameSite": "Strict",
            "priority": "High", "sourceScheme": "Secure", "sourcePort": 443,
        })

    def test_fake_site_transfers_registrable_domain_only(self):
        with patch.object(cookies, "registrable_domain", return_value="example.com") as lookup:
            scoped = dict(COOKIE, domain=".example.com")
            params = cookies.cookie_params(scoped, SAVED_URL)
            self.assertEqual(params["domain"], ".example.com")
            self.assertEqual(params["path"], "/account")
            self.assertNotIn("expires", params)
            lookup.assert_called_once_with("www.login.example.com")
            for domain in (".example.org", ".com", ".login.example.com", "sub.www.login.example.com", "example.com"):
                with self.subTest(domain=domain), self.assertRaises(cookies.CookieRefused):
                    cookies.cookie_params(dict(COOKIE, domain=domain), SAVED_URL)

    def test_domain_transfer_fails_closed_without_psl(self):
        cookies._public_suffix_list.cache_clear()
        self.addCleanup(cookies._public_suffix_list.cache_clear)
        with patch.object(cookies.ctypes, "CDLL", side_effect=OSError("private internal error")):
            with self.assertRaisesRegex(cookies.CookieRefused, "^Cookie transfer refused$"):
                cookies.cookie_params(dict(COOKIE, domain=".example.com"), SAVED_URL)
            self.assertTrue(cookies.cookie_params(COOKIE, SAVED_URL)["secure"])

    def test_preserves_port_persistence_and_serializable_partition(self):
        partition = {"topLevelSite": "https://example.com", "hasCrossSiteAncestor": False}
        persistent = dict(COOKIE, session=False, expires=2000000000, sourcePort=8443, partitionKey=partition)
        params = cookies.cookie_params(persistent, "https://www.login.example.com:8443/")
        self.assertEqual(params["sourcePort"], 8443)
        self.assertEqual(params["expires"], 2000000000)
        self.assertEqual(params["partitionKey"], partition)
        with self.assertRaises(cookies.CookieRefused):
            cookies.cookie_params(persistent, SAVED_URL)

    def test_refuses_unsafe_or_unrepresentable_attributes(self):
        for fields in (
            {"secure": False}, {"secure": 1}, {"sameSite": "unknown"}, {"httpOnly": "false"},
            {"path": "account"}, {"path": "/account\r\n"}, {"sourceScheme": "NonSecure"}, {"sourcePort": 0},
            {"session": True, "expires": 100}, {"session": False, "expires": float("inf")},
            {"partitionKeyOpaque": False}, {"partitionKeyOpaque": True},
            {"partitionKey": {"topLevelSite": "", "hasCrossSiteAncestor": False}},
            {"futureSecurityField": "unknown"},
        ):
            with self.subTest(fields=fields), self.assertRaisesRegex(cookies.CookieRefused, "^Cookie transfer refused$"):
                cookies.cookie_params(dict(COOKIE, **fields), SAVED_URL)

    def test_rollback_preserves_insecure_cookie_and_its_different_source_port(self):
        prior = dict(COOKIE, secure=False, sourceScheme="NonSecure", sourcePort=80)
        params = cookies.restore_cookie(prior, SAVED_URL)
        self.assertEqual(params["url"], "http://www.login.example.com/")
        self.assertFalse(params["secure"])
        self.assertEqual(params["sourceScheme"], "NonSecure")
        self.assertEqual(params["sourcePort"], 80)
        self.assertNotIn("domain", params)

    def test_installed_psl_includes_private_and_multilevel_suffixes(self):
        try:
            cookies._public_suffix_list()
        except cookies.CookieRefused:
            self.skipTest("libpsl is unavailable on this development host")
        self.assertEqual(cookies.registrable_domain("www.login.example.com"), "example.com")
        self.assertEqual(cookies.registrable_domain("a.example.co.uk"), "example.co.uk")
        self.assertEqual(cookies.registrable_domain("a.fake-site.github.io"), "fake-site.github.io")
        self.assertIsNone(cookies.registrable_domain("github.io"))
        self.assertIsNone(cookies.registrable_domain("co.uk"))
        self.assertIsNone(cookies.registrable_domain("127.0.0.1"))
        self.assertEqual(cookies.cookie_params(dict(COOKIE, domain=".example.com"), SAVED_URL)["domain"],
                         ".example.com")
        args = dict(COOKIE, domain=".fake-site.github.io"), "https://a.fake-site.github.io/"
        self.assertEqual(cookies.cookie_params(*args)["domain"], ".fake-site.github.io")
        with self.assertRaises(cookies.CookieRefused):
            cookies.cookie_params(dict(COOKIE, domain=".github.io"), "https://a.fake-site.github.io/")


if __name__ == "__main__":
    unittest.main()
