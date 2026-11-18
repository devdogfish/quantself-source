"""Fill a permitted site in a private Chromium and hand off its session only."""

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import re

from cookies import CookieRefused, cookie_params, https_origin, restore_cookie

CHROMIUM = "/usr/bin/chromium"
NAVIGATION_TIMEOUT = 5000
CDP_TIMEOUT = 2500
TOTP_CODE = re.compile(r"[0-9]{6,10}")
RECIPE_FIELDS = {
    "login_url", "verify_url", "username_selector", "password_selector",
    "submit_selector", "signed_in_selector", "challenge_selectors", "cookie_names",
}
FORM_FIELDS = {"url", "action_url", "submit_selector", "fields", "success_selector"}
TOTP_FIELDS = {"url", "action_url", "submit_selector", "code_selector"}
FORM_NAME = re.compile(r"[a-z][a-z0-9_-]{0,47}")

# Chromium evaluates this in the controlled main frame even with site JavaScript disabled.
# Resolve the effective submission attributes before modifying either field.
SUBMIT = """({ saved, username, password, recipe }) => {
    const user = document.querySelector(recipe.username_selector);
    const secret = document.querySelector(recipe.password_selector);
    const submit = document.querySelector(recipe.submit_selector);
    if (!(user instanceof HTMLInputElement) ||
        !(secret instanceof HTMLInputElement) || secret.type !== "password" ||
        !(submit instanceof HTMLButtonElement || submit instanceof HTMLInputElement) ||
        submit.type !== "submit" || !user.form || user.form !== secret.form ||
        user.form !== submit.form || !user.name || !secret.name || user === secret ||
        user.matches(":disabled") || secret.matches(":disabled") ||
        submit.matches(":disabled")) return "sign_in_blocked";
    const form = user.form;
    const action = submit.hasAttribute("formaction") ? submit.formAction : form.action;
    const method = submit.hasAttribute("formmethod") ? submit.formMethod : form.method;
    const target = submit.hasAttribute("formtarget") ? submit.formTarget :
                   form.target || document.querySelector("base[target]")?.target || "_self";
    const origin = new URL(saved).origin;
    const destination = new URL(action, location.href);
    if (location.origin !== origin || destination.origin !== origin ||
        destination.username || destination.password) return "origin_refused";
    if (method !== "post" || (target && target.toLowerCase() !== "_self")) return "sign_in_blocked";
    user.value = username;
    secret.value = password;
    form.requestSubmit(submit);
    return "submitted";
}"""

# Scripts from the site are disabled. Submit the native form only after checking
# the actual elements, effective destination and target in the same evaluation.
SUBMIT_FORM = """({ originUrl, definition, values, challenge }) => {
    const submit = document.querySelector(definition.submit_selector);
    if (!(submit instanceof HTMLButtonElement || submit instanceof HTMLInputElement) ||
        submit.type !== "submit" || !submit.form || submit.matches(":disabled") ||
        !submit.getClientRects().length) return "form_refused";
    const form = submit.form;
    const target = submit.hasAttribute("formtarget") ? submit.formTarget :
                   form.target || document.querySelector("base[target]")?.target || "_self";
    const action = new URL(submit.hasAttribute("formaction") ? submit.formAction : form.action, location.href);
    const method = submit.hasAttribute("formmethod") ? submit.formMethod : form.method;
    const origin = new URL(originUrl).origin;
    if (location.origin !== origin || action.origin !== origin || action.username || action.password)
        return "origin_refused";
    if (location.href !== new URL(definition.url).href ||
        action.href !== new URL(definition.action_url).href) return "form_refused";
    if (method !== "post" || target.toLowerCase() !== "_self") return "form_refused";
    const sensitive = /pass(?:word|code|wd)?|token|secret|otp|one-time-code|(?:^|[^a-z])pin(?:$|[^a-z])|cvv|cvc|credit.card|cc-/i;
    const allowedInput = /^(text|search|email|url|tel|number)$/;
    if (challenge) {
        const matches = document.querySelectorAll(definition.code_selector);
        const field = matches[0];
        if (matches.length !== 1 || !(field instanceof HTMLInputElement) ||
            !/^(text|tel|number|password)$/.test(field.type) || !field.name || field.form !== form ||
            field.matches(":disabled, [readonly]") || !field.getClientRects().length ||
            Array.from(form.elements).some(other => other !== field && other.type === "password"))
            return "form_refused";
        field.value = values.code;
        if (field.value !== values.code || !form.checkValidity()) return "form_refused";
        form.requestSubmit(submit);
        return "submitted";
    }
    const controls = [];
    for (const [name, selector] of Object.entries(definition.fields)) {
        const matches = document.querySelectorAll(selector);
        const field = matches[0];
        if (matches.length !== 1 || !field.name || field.form !== form ||
            field.matches(":disabled, [readonly]") || !field.getClientRects().length ||
            !(field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement ||
              (field instanceof HTMLInputElement && allowedInput.test(field.type))) ||
            sensitive.test([field.name, field.id, field.autocomplete, field.placeholder,
                            field.getAttribute("aria-label"), ...Array.from(field.labels ?? [], label => label.innerText)]
                           .join(" "))) return "form_refused";
        controls.push([field, values[name]]);
    }
    if (new Set(controls.map(([field]) => field)).size !== controls.length) return "form_refused";
    // Refuse credential forms even when the recipe maps only non-credential inputs.
    if (Array.from(form.elements).some(field => field.type !== "hidden" &&
        (field.type === "password" || sensitive.test([field.name, field.id, field.autocomplete].join(" ")))))
        return "form_refused";
    for (const [field, value] of controls) {
        field.value = value;
        if (field.value !== value || !field.checkValidity()) return "form_refused";
    }
    if (!form.checkValidity()) return "form_refused";
    form.requestSubmit(submit);
    return "submitted";
}"""


def _valid_string(value):
    return isinstance(value, str) and 0 < len(value) <= 2048 and value.strip() == value


def validate_recipe(saved_url, recipe):
    if not isinstance(recipe, dict) or recipe.keys() - {"forms", "totp"} != RECIPE_FIELDS:
        raise ValueError("Invalid login recipe")
    for field in RECIPE_FIELDS - {"challenge_selectors", "cookie_names"}:
        if not _valid_string(recipe[field]):
            raise ValueError("Invalid login recipe")
    for field in ("challenge_selectors", "cookie_names"):
        values = recipe[field]
        if (not isinstance(values, list) or len(values) > 16
                or not all(_valid_string(value) for value in values)
                or len(set(values)) != len(values)):
            raise ValueError("Invalid login recipe")
    if not recipe["cookie_names"]:
        raise ValueError("Invalid login recipe")
    origin = https_origin(saved_url)
    if any(https_origin(recipe[field]) != origin for field in ("login_url", "verify_url")):
        raise CookieRefused
    if "totp" in recipe:
        challenge = recipe["totp"]
        if (not isinstance(challenge, dict) or challenge.keys() != TOTP_FIELDS
                or any(not _valid_string(value) for value in challenge.values())
                or any(https_origin(challenge[field]) != origin or "#" in challenge[field]
                       for field in ("url", "action_url"))):
            raise ValueError("Invalid site TOTP challenge")
    forms = recipe.get("forms", {})
    if not isinstance(forms, dict) or len(forms) > 16:
        raise ValueError("Invalid site forms")
    for name, definition in forms.items():
        if (not isinstance(name, str) or not FORM_NAME.fullmatch(name)
                or not isinstance(definition, dict) or definition.keys() - {"approval"} != FORM_FIELDS
                or definition.get("approval", "owner") not in ("owner", "autonomous")
                or any(not _valid_string(definition[field]) for field in FORM_FIELDS - {"fields"})
                or any(https_origin(definition[field]) != origin for field in ("url", "action_url"))
                or "#" in definition["action_url"]):
            raise ValueError("Invalid site form")
        fields = definition["fields"]
        if (not isinstance(fields, dict) or not 1 <= len(fields) <= 12
                or any(not isinstance(alias, str) or not FORM_NAME.fullmatch(alias)
                       or not _valid_string(selector) for alias, selector in fields.items())):
            raise ValueError("Invalid site form fields")


def _same_origin(url, origin):
    try:
        return https_origin(url) == origin
    except ValueError:
        return False


class OriginBoundary:
    """Check each CDP Fetch request, including subsequent redirect hops."""

    def __init__(self, cdp, origin, cookie_values=None, *, main_frame_id=None):
        self.cdp = cdp
        self.origin = origin
        self.cookie_values = cookie_values
        self.main_frame_id = main_frame_id
        self.refused = False
        self.tasks = set()
        self.post_url = None
        self.posted = False
        self.rewrite_post = None

    def check_request(self, event):
        async def finish():
            try:
                params = {"requestId": event["requestId"]}
                request = event["request"]
                url, method = request["url"], request.get("method", "GET")
                frame_id = event.get("frameId")
                document = event.get("resourceType") == "Document"
                main_document = document and frame_id == self.main_frame_id
                allowed = _same_origin(url, self.origin)
                if allowed and self.post_url is not None and method not in {"GET", "HEAD"}:
                    allowed = main_document and method == "POST" and url == self.post_url and not self.posted
                    if allowed and self.rewrite_post is not None:
                        post_data = self.rewrite_post(request)
                        allowed = post_data is not None
                        if allowed:
                            params["postData"] = post_data
                    if allowed:
                        self.posted = True
                if allowed:
                    await self.cdp.send("Fetch.continueRequest", params, timeout=CDP_TIMEOUT)
                    return
                # Every off-origin request is blocked. A refused embed need not
                # invalidate the still-private, same-origin top-level document.
                if document and (main_document or frame_id is None):
                    self.refused = True
                await self.cdp.send("Fetch.failRequest", params | {"errorReason": "BlockedByClient"},
                                    timeout=CDP_TIMEOUT)
            except Exception:
                self.refused = True

        task = asyncio.create_task(finish())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def remember_response_cookies(self, event):
        # Fetch response headers omit Set-Cookie. The Network extra-info event
        # exposes the original headers, including on redirect responses.
        for name, header in event["headers"].items():
            if name.lower() != "set-cookie":
                continue
            for line in header.splitlines():
                pair = line.partition(";")[0]
                _, separator, value = pair.partition("=")
                value = (value if separator else pair).strip()
                if value:
                    self.cookie_values.add(value)
                if len(value) > 2 and value.startswith('"') and value.endswith('"'):
                    self.cookie_values.add(value[1:-1])

    def remember_request_cookies(self, event):
        self.cookie_values.update(
            entry["cookie"]["value"] for entry in event["associatedCookies"] if entry["cookie"]["value"]
        )

    async def arm(self):
        self.cdp.on("Fetch.requestPaused", self.check_request)
        if self.cookie_values is not None:
            self.cdp.on("Network.requestWillBeSentExtraInfo", self.remember_request_cookies)
            self.cdp.on("Network.responseReceivedExtraInfo", self.remember_response_cookies)
            await self.cdp.send("Network.enable", timeout=CDP_TIMEOUT)
        await self.cdp.send("Network.setBypassServiceWorker", {"bypass": True}, timeout=CDP_TIMEOUT)
        await self.cdp.send("Fetch.enable", timeout=CDP_TIMEOUT)

    async def finish(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def verify(self, page):
        if self.refused or not _same_origin(page.url, self.origin):
            raise CookieRefused


@asynccontextmanager
async def controlled_page(context, origin, cookie_values=None):
    page = await context.new_page()
    boundary = None
    try:
        cdp = await context.new_cdp_session(page)
        tree = await cdp.send("Page.getFrameTree", timeout=CDP_TIMEOUT)
        boundary = OriginBoundary(cdp, origin, cookie_values, main_frame_id=tree["frameTree"]["frame"]["id"])
        await boundary.arm()
        yield page, cdp, boundary
    finally:
        try:
            await page.close()
        finally:
            if boundary is not None:
                await boundary.finish()


async def _visit(page, boundary, url):
    try:
        response = await page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT)
    except Exception:
        if boundary.refused:
            raise CookieRefused from None
        raise
    boundary.verify(page)
    return response is not None and response.ok


async def _authenticated(page, boundary, recipe):
    if not await _visit(page, boundary, recipe["verify_url"]):
        return False
    visible = await page.locator(recipe["signed_in_selector"]).is_visible()
    boundary.verify(page)
    return visible


class LoginHandoff(Exception):
    def __init__(self, status):
        self.status = status


async def _submit(page, boundary, saved_url, username, password, recipe):
    if not await _visit(page, boundary, recipe["login_url"]):
        raise LoginHandoff("unavailable")

    async def challenge_present():
        totp = recipe.get("totp")
        if totp is not None and page.url == totp["url"]:
            if await page.locator(totp["code_selector"]).is_visible():
                return True
        for selector in recipe["challenge_selectors"]:
            if await page.locator(selector).is_visible():
                return True
        return False

    if await challenge_present():
        raise LoginHandoff("sign_in_blocked")
    try:
        async with page.expect_navigation(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT):
            result = await page.evaluate(SUBMIT, {
                "saved": saved_url, "username": username, "password": password, "recipe": recipe,
            })
            if result != "submitted":
                status = "origin_refused" if result == "origin_refused" else "sign_in_blocked"
                raise LoginHandoff(status)
    except LoginHandoff:
        raise
    except Exception:
        if boundary.refused:
            raise CookieRefused from None
        raise LoginHandoff("sign_in_blocked") from None
    boundary.verify(page)
    if await challenge_present() or not await _authenticated(page, boundary, recipe):
        raise LoginHandoff("sign_in_blocked")


async def _submit_site_form(page, boundary, definition, values):
    boundary.post_url = definition["action_url"]
    if not await _visit(page, boundary, definition["url"]):
        return "unavailable"
    return await _post_checked_form(page, boundary, definition, values)


async def _post_checked_form(page, boundary, definition, values, challenge=False):
    boundary.post_url = definition["action_url"]
    try:
        async with page.expect_navigation(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT) as pending:
            result = await page.evaluate(SUBMIT_FORM, {
                "originUrl": definition["url"], "definition": definition, "values": values,
                "challenge": challenge,
            })
            if result != "submitted":
                raise LoginHandoff("origin_refused" if result == "origin_refused" else "form_refused")
        response = await pending.value
        boundary.verify(page)
        if (boundary.posted and response is not None and response.ok
                and (challenge or await page.locator(definition["success_selector"]).is_visible())):
            boundary.verify(page)
            return "submitted"
    except LoginHandoff as refusal:
        return refusal.status
    except Exception:
        pass
    # After requestSubmit, absence of a confirmation does not establish that the site declined the write.
    return "outcome_unknown"


async def _finish_totp(page, boundary, recipe, code):
    status = await _post_checked_form(page, boundary, recipe["totp"], {"code": code}, challenge=True)
    if boundary.refused or status == "origin_refused":
        raise CookieRefused
    if status == "submitted":
        return await _authenticated(page, boundary, recipe)
    return False


def _session_params(cookies, recipe, saved_url):
    names = set(recipe["cookie_names"])
    chosen = [cookie for cookie in cookies if cookie["name"] in names]
    if len(chosen) > 16 or {cookie["name"] for cookie in chosen} != names:
        raise LoginHandoff("transfer_rejected")
    try:
        return [(cookie, cookie_params(cookie, saved_url)) for cookie in chosen]
    except CookieRefused:
        raise LoginHandoff("transfer_rejected") from None


def _cookie_identity(cookie):
    return cookie["name"], cookie["domain"], cookie["path"]


async def _site_cookies(cdp, recipe):
    response = await cdp.send("Network.getCookies", {"urls": [recipe["login_url"], recipe["verify_url"]]},
                              timeout=CDP_TIMEOUT)
    return response["cookies"]


async def _complete_rollback(operations):
    # An Owner lock and the client disconnect can each cancel this login.
    # Finish the bounded CDP cleanup even if both arrive during rollback.
    cleanup = asyncio.gather(*operations, return_exceptions=True)
    cancelled = False
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError
    if any(isinstance(result, BaseException) for result in cleanup.result()):
        raise LoginHandoff("unavailable")


async def _handoff(context, origin, recipe, cookies, cookie_values=None):
    async with controlled_page(context, origin, cookie_values) as (page, cdp, boundary):
        incoming = {_cookie_identity(cookie): (cookie, param) for cookie, param in cookies}
        if len(incoming) != len(cookies):
            return "transfer_rejected"
        restore = {}
        for previous in await _site_cookies(cdp, recipe):
            identity = _cookie_identity(previous)
            if identity not in incoming:
                continue
            candidate, _ = incoming[identity]
            if identity in restore or any(previous.get(key) != candidate.get(key)
                                          for key in ("partitionKey", "sourceScheme", "sourcePort")):
                return "transfer_rejected"
            try:
                restore[identity] = restore_cookie(previous, recipe["verify_url"])
            except CookieRefused:
                return "transfer_rejected"
        changed = {identity: (cookie, param) for identity, (cookie, param) in incoming.items()
                   if restore.get(identity) != param}
        accepted = False
        try:
            if changed:
                await cdp.send("Network.setCookies", {"cookies": [param for _, param in changed.values()]},
                               timeout=CDP_TIMEOUT)
            expected = {identity: param for identity, (_, param) in incoming.items()}
            actual = {_cookie_identity(cookie): cookie_params(cookie, recipe["verify_url"])
                      for cookie in await _site_cookies(cdp, recipe) if _cookie_identity(cookie) in expected}
            accepted = actual == expected and await _authenticated(page, boundary, recipe)
        except Exception:
            return "transfer_rejected"
        finally:
            if not accepted:
                remove = []
                for identity, (cookie, _) in changed.items():
                    if identity in restore:
                        continue
                    fields = ("name", "domain", "path", "partitionKey")
                    remove.append(cdp.send("Network.deleteCookies", {key: cookie[key] for key in fields if key in cookie},
                                           timeout=CDP_TIMEOUT))
                previous = [restore[identity] for identity in changed if identity in restore]
                if previous:
                    remove.append(cdp.send("Network.setCookies", {"cookies": previous}, timeout=CDP_TIMEOUT))
                await _complete_rollback(remove)
        return "signed_in" if accepted else "transfer_rejected"


async def _remember_cookie_values(context, values):
    async with asyncio.timeout(CDP_TIMEOUT / 1000):
        cookies = await context.cookies()
    values.update(cookie["value"] for cookie in cookies if cookie["value"])


class ProtectedBrowser:
    """Host authenticated sessions in service-owned browser contexts over a private pipe."""

    def __init__(self, launch_args=(), *, origin_proxy=None):
        self.playwright = None
        self.browser = None
        self.sessions = {}
        self.launch_args = launch_args
        self.origin_proxy = origin_proxy

    async def _start(self):
        if self.browser is not None and self.browser.is_connected():
            return
        await self.close()
        from playwright.async_api import async_playwright

        self.playwright = await async_playwright().start()
        try:
            args = ["--disable-background-networking", *self.launch_args]
            if self.origin_proxy is not None:
                port = await self.origin_proxy.start()
                args.extend([f"--proxy-server=http://127.0.0.1:{port}", "--proxy-bypass-list=<-loopback>"])
            self.browser = await self.playwright.chromium.launch(
                executable_path=CHROMIUM, headless=True, chromium_sandbox=True,
                args=args, timeout=NAVIGATION_TIMEOUT,
            )
        except BaseException:
            await self.close()
            raise

    async def _context(self, *, java_script_enabled=False):
        await self._start()
        return await self.browser.new_context(
            java_script_enabled=java_script_enabled, service_workers="block", accept_downloads=False,
        )

    async def close(self):
        self.sessions.clear()
        browser, self.browser = self.browser, None
        playwright, self.playwright = self.playwright, None
        try:
            if browser is not None:
                await browser.close()
        finally:
            try:
                if playwright is not None:
                    await playwright.stop()
            finally:
                if self.origin_proxy is not None:
                    await self.origin_proxy.close()

    async def _accept_login(self, item_id, origin, recipe, cookies, values):
        # Verify a replacement in a fresh context before discarding a usable session.
        destination = await self._context()
        try:
            values.update(cookie["value"] for cookie, _ in cookies if cookie["value"])
            status = await _handoff(destination, origin, recipe, cookies, values)
            if status == "signed_in":
                previous = self.sessions.get(item_id)
                self.sessions[item_id] = (destination, origin, recipe, values)
                destination = None
                if previous is not None:
                    await previous[0].close()
            return status
        finally:
            if destination is not None:
                await destination.close()

    async def sign_in(self, item_id, saved_url, username, password, recipe, supply_totp=None):
        try:
            validate_recipe(saved_url, recipe)
            origin = https_origin(saved_url)
            values = {password}
            async with AsyncExitStack() as resources:
                private = await self._context()
                resources.push_async_callback(private.close)
                page, cdp, boundary = await resources.enter_async_context(controlled_page(private, origin, values))
                try:
                    await _submit(page, boundary, saved_url, username, password, recipe)
                except LoginHandoff as result:
                    definition = recipe.get("totp")
                    if (result.status != "sign_in_blocked" or definition is None or page.url != definition["url"]
                            or not await page.locator(definition["code_selector"]).is_visible()):
                        raise
                    boundary.verify(page)
                    code = await supply_totp() if supply_totp is not None else None
                    if code is None or not TOTP_CODE.fullmatch(code) or not await _finish_totp(page, boundary, recipe, code):
                        return "sign_in_blocked"
                    values.add(code)
                boundary.verify(page)
                cookies = _session_params(await _site_cookies(cdp, recipe), recipe, saved_url)
            return await self._accept_login(item_id, origin, recipe, cookies, values)
        except LoginHandoff as result:
            return result.status
        except CookieRefused:
            return "origin_refused"
        except Exception:
            return "unavailable"

    async def read(self, item_id, url):
        session = self.sessions.get(item_id)
        if session is None:
            return {"status": "sign_in_required"}
        context, origin, recipe, values = session
        target = recipe["verify_url"] if url is None else url
        if not _same_origin(target, origin):
            return {"status": "origin_refused"}
        try:
            async with controlled_page(context, origin, values) as (page, _, boundary):
                # A response can clear a sent cookie or redirect to a different cookie path.
                await _remember_cookie_values(context, values)
                if not await _visit(page, boundary, target):
                    return {"status": "unavailable"}
                text = await page.locator("body").inner_text(timeout=NAVIGATION_TIMEOUT)
                boundary.verify(page)
                await _remember_cookie_values(context, values)
            for value in sorted(values, key=len, reverse=True):
                text = text.replace(value, "[redacted]")
            result = {"status": "ok", "text": text[:4000]}
            if recipe.get("forms"):
                result["forms"] = {name: list(form["fields"]) for name, form in recipe["forms"].items()}
            return result
        except CookieRefused:
            return {"status": "origin_refused"}
        except Exception:
            return {"status": "unavailable"}

    async def submit(self, item_id, form_name, fields):
        session = self.sessions.get(item_id)
        if session is None:
            return "sign_in_required"
        context, origin, recipe, values = session
        definition = recipe.get("forms", {}).get(form_name)
        if definition is None or fields.keys() != definition["fields"].keys():
            return "form_refused"
        status = None
        try:
            async with controlled_page(context, origin, values) as (page, _, boundary):
                status = await _submit_site_form(page, boundary, definition, fields)
            return status
        except CookieRefused:
            return "origin_refused"
        except Exception:
            return "outcome_unknown" if status in {"submitted", "outcome_unknown"} else "unavailable"
