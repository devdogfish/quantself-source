"""Validate the origin and preserve Chromium cookie scope during a handoff."""

import ctypes
from functools import cache
from ipaddress import ip_address
import re
import sys
from urllib.parse import urlsplit

DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
IPV4_LIKE = re.compile(r"(?:[0-9]+|0x[0-9a-f]*)")
COOKIE_FIELDS = frozenset({
    "name", "value", "domain", "path", "secure", "httpOnly", "session", "expires",
    "size", "sameSite", "priority", "sourceScheme", "sourcePort", "partitionKey",
})
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class CookieRefused(ValueError):
    """A cookie or origin cannot be transferred safely."""

    def __init__(self):
        super().__init__("Cookie transfer refused")


def https_origin(url):
    """Return the canonical host and effective port of a saved HTTPS URL."""
    if not isinstance(url, str) or "\\" in url or any(ord(char) <= 32 or ord(char) == 127 for char in url):
        raise CookieRefused
    try:
        split = urlsplit(url)
        host = split.hostname
        port = split.port
    except ValueError:
        raise CookieRefused from None
    if split.scheme != "https" or not host or not split.netloc.isascii() or "%" in host or port == 0:
        raise CookieRefused
    authority_host = f"[{host}]" if ":" in host else host
    if not re.fullmatch(rf"{re.escape(authority_host)}(?::[0-9]+)?", split.netloc.lower()):
        raise CookieRefused
    try:
        return ip_address(host).compressed, 443 if port is None else port
    except ValueError:
        pass
    labels = host.split(".")
    # Chromium interprets a DNS-looking URL ending in a number as an IPv4 address.
    if (len(host) > 253 or not all(DNS_LABEL.fullmatch(label) for label in labels)
            or IPV4_LIKE.fullmatch(labels[-1])):
        raise CookieRefused
    return host, 443 if port is None else port


@cache
def _public_suffix_list():
    try:
        library = ctypes.CDLL("libpsl.5.dylib" if sys.platform == "darwin" else "libpsl.so.5")
        library.psl_builtin.argtypes = []
        library.psl_builtin.restype = ctypes.c_void_p
        library.psl_registrable_domain.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        library.psl_registrable_domain.restype = ctypes.c_char_p
        context = library.psl_builtin()
    except (OSError, AttributeError):
        raise CookieRefused from None
    if not context:
        raise CookieRefused
    return library, context


def registrable_domain(host):
    """Consult both the ICANN and the private sections of the installed PSL."""
    try:
        ip_address(host)
    except ValueError:
        library, context = _public_suffix_list()
        domain = library.psl_registrable_domain(context, host.encode("ascii"))
        return domain.decode("ascii") if domain else None
    return None


def _cookie_params(cookie, saved_url, *, restoring):
    if not isinstance(cookie, dict) or cookie.keys() - COOKIE_FIELDS:
        # Chromium also emits partitionKeyOpaque=false for non-serializable nonce partitions.
        raise CookieRefused
    host, port = https_origin(saved_url)
    url_host = f"[{host}]" if ":" in host else host
    domain = cookie.get("domain")
    domain_scope = isinstance(domain, str) and domain.startswith(".")
    if domain_scope:
        root = registrable_domain(host)
        if root is None or domain != f".{root}":
            raise CookieRefused
    elif domain != url_host:
        raise CookieRefused

    name, value, path = (cookie.get(field) for field in ("name", "value", "path"))
    if (not all(isinstance(part, str) and not CONTROL.search(part) for part in (name, value, path))
            or not path.startswith("/")):
        raise CookieRefused
    secure, http_only, session = (cookie.get(field) for field in ("secure", "httpOnly", "session"))
    if (not all(type(flag) is bool for flag in (secure, http_only, session))
            or not (secure or restoring)):
        raise CookieRefused
    expires = cookie.get("expires")
    if (type(expires) not in (int, float)
            or not (expires == -1 if session else 0 <= expires <= (2**53 - 1))):
        raise CookieRefused
    source_scheme = cookie.get("sourceScheme")
    source_port = cookie.get("sourcePort")
    if (source_scheme not in ("Unset", "NonSecure", "Secure") or (secure and source_scheme == "NonSecure")
            or type(source_port) is not int or (source_port != -1 and not 1 <= source_port <= 65535)
            or (not restoring and source_port not in (-1, port))):
        raise CookieRefused

    # Omitting Domain preserves a host-only cookie. The explicit sourcePort preserves
    # Chromium's port metadata even though the URL used to set the cookie has no port.
    params = {
        "url": f"{'https' if secure else 'http'}://{url_host}/",
        "name": name, "value": value, "path": path, "secure": secure, "httpOnly": http_only,
        "sourceScheme": source_scheme, "sourcePort": source_port,
    }
    if domain_scope:
        params["domain"] = domain
    if not session:
        params["expires"] = expires
    for field, allowed in (("sameSite", ("Strict", "Lax", "None")), ("priority", ("Low", "Medium", "High"))):
        if field in cookie:
            if cookie[field] not in allowed:
                raise CookieRefused
            params[field] = cookie[field]
    if "partitionKey" in cookie:
        partition = cookie["partitionKey"]
        if (not isinstance(partition, dict) or partition.keys() != {"topLevelSite", "hasCrossSiteAncestor"}
                or not isinstance(partition["topLevelSite"], str) or not partition["topLevelSite"]
                or type(partition["hasCrossSiteAncestor"]) is not bool):
            raise CookieRefused
        params["partitionKey"] = partition.copy()
    return params


def cookie_params(cookie, saved_url):
    """Convert a permitted Network.Cookie to a Network.CookieParam."""
    return _cookie_params(cookie, saved_url, restoring=False)


def restore_cookie(cookie, saved_url):
    """Reconstruct a prior cookie from the destination browser for rollback."""
    return _cookie_params(cookie, saved_url, restoring=True)
