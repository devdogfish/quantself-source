"""Native account forms in a private Chromium pinned to a public HTTPS origin."""

import asyncio
from base64 import b32decode, b64encode, urlsafe_b64encode
from contextlib import AsyncExitStack
from ipaddress import ip_address, ip_network
import json
import re
import secrets
import socket
from urllib.parse import parse_qs, parse_qsl, quote, unquote, urlencode, urlsplit

from browser import (
    CDP_TIMEOUT, NAVIGATION_TIMEOUT, LoginHandoff, ProtectedBrowser, _same_origin,
    _visit, controlled_page,
)
from cookies import CookieRefused, cookie_params, https_origin
from origin_proxy import PinnedOriginProxy

# DNS-only gating should also exclude transition ranges that can embed another IPv4 endpoint.
IPV6_TRANSITION = tuple(ip_network(value) for value in ("64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16"))
SITE_BROWSER_ARGS = (
    # Chromium still resolves the proxy endpoint through these rules.
    "--host-resolver-rules=EXCLUDE 127.0.0.1, MAP * ~NOTFOUND",
    "--disable-quic", "--disable-http2",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
)


async def open_site(url):
    host, port = https_origin(url)
    if "." not in host or urlsplit(url).fragment:
        raise CookieRefused
    async with asyncio.timeout(5):
        answers = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = {ip_address(answer[4][0]) for answer in answers}
    if not addresses or any(not public_address(address) for address in addresses):
        raise CookieRefused
    address = min(addresses, key=lambda ip: (ip.version, int(ip)))
    return Site(url, (host, port), ProtectedBrowser(
        SITE_BROWSER_ARGS, origin_proxy=PinnedOriginProxy((host, port), address),
    ))


def public_address(address):
    return (address.is_global and not address.is_multicast and not address.is_reserved
            and not address.is_loopback and not address.is_link_local
            and (address.version == 4 or (
                address.ipv4_mapped is None and address.scope_id is None
                and all(address not in network for network in IPV6_TRANSITION)
            )))


# The isolated world discovers and rechecks the form, then fills placeholders.
NATIVE_FORM = r"""({ mode, expected, values }) => {
    const visible = el => el.getClientRects().length && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const enabled = el => !el.matches(":disabled, [readonly]");
    const formProperty = (form, name) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(form);
    const text = el => [el.name, el.id, el.autocomplete, el.placeholder,
        el.getAttribute("aria-label"), ...Array.from(el.labels || [], l => l.innerText)]
        .filter(Boolean).join(" ").replace(/[_-]+/g, " ").toLowerCase();
    const has = (el, token) => el.autocomplete.split(/\s+/).includes(token);
    const forms = Array.from(document.forms);
    const candidates = [];
    for (const [formIndex, form] of forms.entries()) {
        const elements = Array.from(formProperty(form, "elements"));
        const buttons = elements.filter(el => el.type === "submit" && visible(el) && enabled(el));
        if (buttons.length !== 1 || !visible(form)) continue;
        const button = buttons[0];
        const action = new URL(button.hasAttribute("formaction") ? button.formAction : formProperty(form, "action"), location.href);
        const method = button.hasAttribute("formmethod") ? button.formMethod : formProperty(form, "method");
        const target = button.hasAttribute("formtarget") ? button.formTarget :
            formProperty(form, "target") || document.querySelector("base[target]")?.target || "_self";
        if (action.origin !== location.origin || action.username || action.password || action.hash ||
            method !== "post" || (target && target.toLowerCase() !== "_self")) continue;
        const controls = elements.filter(el => el !== button && el.name && !el.matches(":disabled")
            && el.type !== "hidden" && el.type !== "button" && el.type !== "reset"
            && !(el.type === "checkbox" && !el.checked && !el.required));
        if (controls.some(el => !(el instanceof HTMLInputElement) || !visible(el) || !enabled(el))) continue;
        const label = (button instanceof HTMLInputElement ? button.value : button.innerText).trim().toLowerCase();
        const passwords = controls.filter(el => el.type === "password");
        let fields = {};
        if (mode === "logout") {
            if (controls.length || !/^(?:log\s*out|sign\s*out)$/.test(label)) continue;
        } else if (mode === "code") {
            const detector = el => has(el, "one-time-code") ||
                /\b(?:otp|totp|verification code|authenticator code|security code|code)\b/.test(text(el));
            if (controls.length !== 1 || !detector(controls[0]) ||
                !/^(text|tel|number|password)$/.test(controls[0].type)) continue;
            fields = { code: elements.indexOf(controls[0]) };
        } else {
            const creating = elements.some(el => el.type === "hidden" && el.name === "creating" && el.value);
            const signup = creating || /\b(?:sign\s*up|register|create (?:an )?account|join)\b/.test(label)
                || passwords.some(el => has(el, "new-password"));
            const signin = /\b(?:log\s*in|sign\s*in)\b/.test(label)
                || passwords.some(el => has(el, "current-password"));
            if (signup && signin || (mode === "signup" ? !signup : signup || !signin)) continue;
            if (passwords.length < 1 || passwords.length > (mode === "signup" ? 2 : 1)) continue;
            const identifiers = controls.filter(el => el.type !== "password");
            if (identifiers.length < 1 || identifiers.length > (mode === "signup" ? 2 : 1)
                || identifiers.some(el => !/^(text|email)$/.test(el.type))) continue;
            const emailFields = identifiers.filter(el => el.type === "email" || has(el, "email")
                || /\be-?mail\b/.test(text(el)));
            if (emailFields.length > 1 || identifiers.length === 2 && emailFields.length !== 1) continue;
            for (const identifier of identifiers) {
                const role = emailFields.includes(identifier) ? "email" : "username";
                if (mode === "signup" && role === "email" && identifiers.length === 2 &&
                    !identifier.required && /\boptional\b/.test(text(identifier))) continue;
                fields[role] = elements.indexOf(identifier);
            }
            if (passwords.length === 2) {
                const confirmation = passwords.filter(el => /\b(?:confirm|repeat|again|retype)\b/.test(text(el)));
                if (confirmation.length !== 1) continue;
                fields.confirm = elements.indexOf(confirmation[0]);
                fields.password = elements.indexOf(passwords.find(el => el !== confirmation[0]));
            } else {
                fields.password = elements.indexOf(passwords[0]);
            }
        }
        const names = Object.values(fields).map(index => elements[index].name);
        if (new Set(names).size !== names.length) continue;
        candidates.push({ form: formIndex, button: elements.indexOf(button), fields, names,
                          action: action.href, page: location.href });
    }
    if (candidates.length !== 1) return null;
    const found = candidates[0];
    if (!expected) return found;
    if (JSON.stringify(found) !== JSON.stringify(expected)) return null;
    const form = forms[found.form];
    const elements = Array.from(formProperty(form, "elements"));
    for (const [name, index] of Object.entries(found.fields)) {
        const field = elements[index];
        const value = values[name];
        if (typeof value !== "string" || !value || field.maxLength >= 0 && value.length > field.maxLength
            || field.minLength >= 0 && value.length < field.minLength) return null;
        field.value = value;
        if (field.value !== value || !field.checkValidity()) return null;
    }
    if (!HTMLFormElement.prototype.checkValidity.call(form)) return null;
    HTMLFormElement.prototype.requestSubmit.call(form, elements[found.button]);
    return true;
}"""

PAGE_MARKERS = r"""() => {
    const visible = el => el.getClientRects().length && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const links = [...document.querySelectorAll("a[href]")];
    const anchors = links.filter(visible);
    const label = el => el.innerText.trim().toLowerCase();
    const local = el => {
        const url = new URL(el.href);
        return url.origin === location.origin && !url.username && !url.password && !url.hash &&
            (!el.target || el.target.toLowerCase() === "_self") && !el.hasAttribute("download");
    };
    const logoutLabel = /^(?:log\s*out|sign\s*out)$/i;
    const logoutPath = /(?:^|\/)(?:logout|log[-_]out|signout|sign[-_]out)(?:\/|$)/i;
    const logout = links.filter(el => {
        if (!local(el) || !logoutPath.test(new URL(el.href).pathname)) return false;
        if (visible(el) && logoutLabel.test(label(el))) return true;
        const menu = el.closest("li > ul, [role=menu]");
        const nav = menu?.closest("nav, [role=navigation]");
        if (!nav || !visible(nav) || el.closest("[hidden], [inert], [aria-hidden=true]")) return false;
        const text = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent).join("").trim();
        return [el.getAttribute("aria-label"), label(el), text].some(value => logoutLabel.test(value));
    }).map(el => el.href);
    const signin = anchors.filter(el => local(el) && /^(?:log\s*in|sign\s*in)$/.test(label(el)))
        .map(el => el.href);
    const signup = anchors.filter(el => local(el) && /^(?:sign\s*up|register|create (?:an )?account|join)$/.test(label(el)))
        .map(el => el.href);
    const totp = [...document.querySelectorAll('a[href^="otpauth://totp/"]')].filter(visible).map(el=>el.href);
    const text = document.body?.innerText.slice(0, 4000) || "";
    const email = /\b(?:verify|verification|code)\b[^.\n]{0,120}\be-?mail\b|\be-?mail(?:ed)?\b[^.\n]{0,120}\b(?:verification|code)\b/i
        .test(text);
    return { logout: [...new Set(logout)], signin: [...new Set(signin)], signup: [...new Set(signup)],
             totp, email, authenticator: /\b(?:authenticator|totp|two-factor|2fa)\b/i.test(text) };
}"""


def valid_seed(value, username, email):
    if len(value) > 2048 or any(ord(char) <= 32 for char in value):
        return None
    try:
        origin = urlsplit(value)
    except ValueError:
        return None
    params = parse_qs(origin.query, keep_blank_values=True)
    if (origin.scheme != "otpauth" or origin.netloc != "totp" or origin.fragment
            or not origin.path.startswith("/") or origin.path.count("/") != 1
            or params.keys() - {"secret", "issuer", "algorithm", "digits", "period"}
            or any(len(values) != 1 for values in params.values())):
        return None
    label = unquote(origin.path[1:])
    issuer, separator, account = label.partition(":")
    if not separator:
        account = issuer
    accounts = {value.casefold() for value in (username, email) if value}
    if account.strip().casefold() not in accounts or (
        separator and params.get("issuer", [issuer])[0] != issuer
    ):
        return None
    secret, = params.get("secret", [""])
    if not re.fullmatch(r"[A-Z2-7]{16,128}", secret):
        return None
    try:
        b32decode(secret + "=" * (-len(secret) % 8))
    except ValueError:
        return None
    if (params.get("algorithm", ["SHA1"])[0] not in ("SHA1", "SHA256", "SHA512")
            or params.get("digits", ["6"])[0] not in ("6", "8")
            or params.get("period", ["30"])[0] != "30"):
        return None
    return value


def redact(text, secrets):
    for secret in sorted(secrets, key=len, reverse=True):
        raw = secret.encode()
        variants = {secret, quote(secret, safe="")}
        if len(raw) >= 6:
            variants.update({raw.hex(), raw.hex().upper()})
            for encoded in (b64encode(raw).decode(), urlsafe_b64encode(raw).decode()):
                variants.update({encoded, encoded.rstrip("=")})
        for variant in sorted(variants, key=len, reverse=True):
            text = text.replace(variant, "[redacted]")
    return text


async def evaluate(boundary, source, argument=None):
    world = await boundary.cdp.send("Page.createIsolatedWorld", {
        "frameId": boundary.main_frame_id, "worldName": "quantself-vaultwarden",
    }, timeout=CDP_TIMEOUT)
    result = await boundary.cdp.send("Runtime.evaluate", {
        "contextId": world["executionContextId"],
        "expression": f"({source})({json.dumps(argument)})", "returnByValue": True,
    }, timeout=CDP_TIMEOUT)
    if "exceptionDetails" in result:
        raise CookieRefused
    return result["result"].get("value")


def private_form_data(request, substitutions):
    headers = {name.lower(): value for name, value in request["headers"].items()}
    if headers.get("content-type", "").partition(";")[0] != "application/x-www-form-urlencoded":
        return None
    body = request.get("postData", "")
    if len(body) > 32768:
        return None
    try:
        fields = parse_qsl(body, keep_blank_values=True, strict_parsing=True, max_num_fields=128, errors="strict")
    except ValueError:
        return None
    remaining = dict(substitutions)
    for index, (name, value) in enumerate(fields):
        if name in substitutions:
            expected, actual = remaining.pop(name, (None, None))
            if value != expected:
                return None
            fields[index] = (name, actual)
    return None if remaining else b64encode(urlencode(fields).encode()).decode()


class Site:
    def __init__(self, url, origin, browser):
        self.url = url
        self.origin = origin
        self.browser = browser
        self.context = None
        self.page = None
        self.resources = None
        self.challenge = None
        self.landing = url
        self.signed_in = False
        self.secrets = set()
        self.initial_cookies = set()
        self.mode = None
        self.used_challenges = set()

    async def _context(self):
        context = await self.browser._context(java_script_enabled=True)
        try:
            await context.route("**/*", self._route)
            await context.route_web_socket("**/*", self._refuse_web_socket)
        except BaseException:
            await context.close()
            raise
        return context

    async def _route(self, route):
        request = route.request
        # Requests without a frame can occur before a new window's frame exists.
        try:
            primary = self.page is not None and request.frame == self.page.main_frame
        except Exception:
            primary = False
        if primary and _same_origin(request.url, self.origin):
            await route.continue_()
        else:
            await route.abort()

    async def _refuse_web_socket(self, route):
        await route.close()

    async def _close_popup(self, page):
        if page is not self.page:
            await page.close()

    async def _new_page(self):
        await self._clear_page()
        self.resources = AsyncExitStack()
        page, cdp, boundary = await self.resources.enter_async_context(
            controlled_page(self.context, self.origin, self.secrets)
        )
        self.page = page
        self.context.on("page", self._close_popup)
        self.resources.callback(self.context.remove_listener, "page", self._close_popup)
        # No POST is allowed outside a single checked submission.
        boundary.post_url = ""
        return page, cdp, boundary

    async def _clear_page(self):
        resources, self.resources = self.resources, None
        self.challenge = None
        if resources is not None:
            await resources.aclose()
        self.page = None

    async def _clear_context(self):
        try:
            await self._clear_page()
        finally:
            context, self.context = self.context, None
            self.signed_in = False
            self.secrets.clear()
            self.initial_cookies.clear()
            self.used_challenges.clear()
            if context is not None:
                await context.close()

    async def close(self):
        try:
            await self._clear_context()
        finally:
            await self.browser.close()

    async def _markers(self, page, boundary):
        boundary.verify(page)
        facts = await evaluate(boundary, PAGE_MARKERS)
        boundary.verify(page)
        return facts

    async def _cookies(self, page, cdp):
        reply = await cdp.send("Network.getCookies", {"urls": [page.url]}, timeout=CDP_TIMEOUT)
        cookies = reply["cookies"]
        if len(cookies) > 32:
            raise CookieRefused
        for cookie in cookies:
            if cookie["value"]:
                self.secrets.add(cookie["value"])
        return cookies

    async def _authenticated(self, page, cdp, boundary, facts):
        if not facts["logout"] and not await self._form(boundary, "logout"):
            return False
        cookies = [cookie for cookie in await self._cookies(page, cdp)
                   if cookie["value"] and cookie["value"] not in self.initial_cookies]
        try:
            for cookie in cookies:
                cookie_params(cookie, self.url)
        except CookieRefused:
            return False
        boundary.verify(page)
        return bool(cookies)

    async def _form(self, boundary, mode):
        return await evaluate(boundary, NATIVE_FORM, {"mode": mode})

    async def _post(self, page, boundary, mode, form, values):
        boundary.verify(page)
        if not _same_origin(form["action"], self.origin) or page.url != form["page"]:
            raise CookieRefused
        placeholders = dict(values)
        substitutions = {}
        password_placeholder = "Aa1!" + secrets.token_urlsafe(24)
        for role, name in zip(form["fields"], form["names"], strict=True):
            value = values[role]
            if role in {"password", "confirm"}:
                placeholders[role] = password_placeholder[:len(value)]
            elif role == "code":
                # Always differ from the real code, while satisfying numeric controls.
                limit = 10 ** len(value)
                other_code = (int(value) + secrets.randbelow(limit - 1) + 1) % limit
                placeholders[role] = f"{other_code:0{len(value)}d}"
            if role in {"password", "confirm", "code"} and placeholders[role] == value:
                raise LoginHandoff("unsupported")
            substitutions[name] = (placeholders[role], value)
        boundary.post_url = form["action"]
        boundary.posted = False
        if substitutions:
            boundary.rewrite_post = lambda request: private_form_data(request, substitutions)
        try:
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT) as pending:
                if not await evaluate(boundary, NATIVE_FORM,
                                      {"mode": mode, "expected": form, "values": placeholders}):
                    raise LoginHandoff("unsupported")
            result = await pending.value
            boundary.verify(page)
            return boundary.posted and result is not None and result.ok
        except LoginHandoff:
            raise
        except Exception:
            if boundary.refused:
                raise CookieRefused from None
            return False
        finally:
            boundary.post_url = ""
            boundary.rewrite_post = None

    async def _outcome(self, page, cdp, boundary):
        facts = await self._markers(page, boundary)
        form = await self._form(boundary, "code")
        if form:
            if len(facts["totp"]) == 1 and self.mode == "signup":
                status = "totp_setup_required"
            elif not facts["totp"] and facts["email"] and not facts["authenticator"]:
                status = "email_verification_required"
            elif not facts["totp"] and not facts["email"] and (
                facts["authenticator"] or self.mode == "sign_in"
            ):
                status = "totp_required"
            else:
                return "unsupported"
            if status in self.used_challenges:
                return "unconfirmed"
            self.challenge = (status, page, cdp, boundary, form, facts["totp"])
            return status
        if not await self._authenticated(page, cdp, boundary, facts):
            return "unconfirmed"
        self.landing = page.url
        self.signed_in = True
        return "signed_in"

    async def start(self, mode, username, password, email, before_submit=None):
        if mode not in {"signup", "sign_in"}:
            return "unsupported"
        preparing = False
        try:
            await self._clear_context()
            self.context = await self._context()
            self.mode = mode
            page, cdp, boundary = await self._new_page()
            if not await _visit(page, boundary, self.url):
                return "unsupported"
            form = await self._form(boundary, mode)
            if form is None:
                facts = await self._markers(page, boundary)
                links = facts["signin"]
                if mode == "signup" and facts["signup"]:
                    links = facts["signup"]
                if len(links) != 1 or not await _visit(page, boundary, links[0]):
                    return "unsupported"
                form = await self._form(boundary, mode)
            if form is None or not _same_origin(form["action"], self.origin):
                return "unsupported"
            if "email" in form["fields"] and not email:
                return "unsupported"
            if mode == "signup" and "email" in form["fields"] and "username" not in form["fields"]:
                if username.casefold() != email.casefold():
                    return "unsupported"
            self.initial_cookies = {cookie["value"] for cookie in await self._cookies(page, cdp)}
            if before_submit is not None:
                preparing = True
                await before_submit()
                preparing = False
            self.secrets.add(password)
            values = {"username": username, "email": email, "password": password, "confirm": password}
            if not await self._post(page, boundary, mode, form, values):
                return "unconfirmed"
            return await self._outcome(page, cdp, boundary)
        except CookieRefused:
            return "origin_refused"
        except LoginHandoff as blocked:
            return blocked.status
        except Exception:
            if preparing:
                raise
            return "unconfirmed"
        finally:
            if self.challenge is None:
                if self.signed_in:
                    await self._clear_page()
                else:
                    await self._clear_context()

    async def totp_seed(self, username, email):
        if self.challenge is None or self.challenge[0] != "totp_setup_required":
            return None
        _, page, _, boundary, form, seeds = self.challenge
        boundary.verify(page)
        seed = valid_seed(seeds[0], username, email) if page.url == form["page"] else None
        if seed is not None:
            self.secrets.update({seed, parse_qs(urlsplit(seed).query)["secret"][0]})
        return seed

    async def code(self, value):
        if self.challenge is None or not isinstance(value, str):
            return "unsupported"
        status, page, cdp, boundary, form, _ = self.challenge
        pattern = r"[0-9]{4,10}" if status == "email_verification_required" else r"(?:[0-9]{6}|[0-9]{8})"
        if not re.fullmatch(pattern, value):
            return "unsupported"
        self.challenge = None
        self.used_challenges.add(status)
        try:
            self.secrets.add(value)
            if not await self._post(page, boundary, "code", form, {"code": value}):
                return "unconfirmed"
            return await self._outcome(page, cdp, boundary)
        except CookieRefused:
            return "origin_refused"
        except LoginHandoff as blocked:
            return blocked.status
        except Exception:
            return "unconfirmed"
        finally:
            if self.challenge is None:
                if self.signed_in:
                    await self._clear_page()
                else:
                    await self._clear_context()

    async def _login_visible(self, boundary):
        return await self._form(boundary, "sign_in") is not None

    async def sign_out(self):
        if not self.signed_in or self.context is None:
            return "sign_in_required"
        try:
            page, cdp, boundary = await self._new_page()
            if not await _visit(page, boundary, self.landing):
                return "unconfirmed"
            facts = await self._markers(page, boundary)
            links = facts["logout"]
            if len(links) == 1:
                if not await _visit(page, boundary, links[0]):
                    return "unconfirmed"
            elif not links and (form := await self._form(boundary, "logout")):
                if not await self._post(page, boundary, "logout", form, {}):
                    return "unconfirmed"
            else:
                return "unsupported"
            facts = await self._markers(page, boundary)
            if await self._authenticated(page, cdp, boundary, facts):
                return "unconfirmed"
            if not facts["signin"] and not await self._login_visible(boundary):
                if not await _visit(page, boundary, self.url) or not await self._login_visible(boundary):
                    return "unconfirmed"
            await self._clear_context()
            return "signed_out"
        except CookieRefused:
            return "origin_refused"
        except LoginHandoff as blocked:
            return blocked.status
        except Exception:
            return "unconfirmed"
        finally:
            await self._clear_page()

    async def reopen(self):
        try:
            await self.close()
            self.context = await self._context()
            page, cdp, boundary = await self._new_page()
            if not await _visit(page, boundary, self.url):
                return "unconfirmed"
            facts = await self._markers(page, boundary)
            if await self._authenticated(page, cdp, boundary, facts):
                self.signed_in = True
                self.landing = page.url
                return "signed_in"
            if facts["signin"] or await self._login_visible(boundary):
                return "signed_out"
            return "unconfirmed"
        except CookieRefused:
            return "origin_refused"
        except Exception:
            return "unconfirmed"
        finally:
            await self._clear_page()

    async def read(self, url):
        if not self.signed_in or self.context is None:
            return {"status": "sign_in_required"}
        url = url or self.landing
        if not _same_origin(url, self.origin):
            return {"status": "origin_refused"}
        try:
            page, cdp, boundary = await self._new_page()
            # Active site scripts can transform JS-readable session values beyond redaction.
            await cdp.send("Emulation.setScriptExecutionDisabled", {"value": True}, timeout=CDP_TIMEOUT)
            if not await _visit(page, boundary, url):
                return {"status": "unavailable"}
            facts = await self._markers(page, boundary)
            if facts["totp"] or await page.locator('input[type="password"], input[autocomplete="one-time-code"]').count():
                return {"status": "sign_in_required"}
            await self._cookies(page, cdp)
            text = await page.locator("body").inner_text(timeout=NAVIGATION_TIMEOUT)
            boundary.verify(page)
            return {"status": "ok", "text": redact(text, self.secrets)[:4000]}
        except CookieRefused:
            return {"status": "origin_refused"}
        except Exception:
            return {"status": "unavailable"}
        finally:
            await self._clear_page()
