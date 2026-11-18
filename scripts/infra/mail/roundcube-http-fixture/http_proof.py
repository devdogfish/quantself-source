"""Exercise stock Roundcube login and message response inside the fixture network."""

from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from html import escape
from html.parser import HTMLParser
from http.client import HTTPSConnection
from http.cookiejar import CookieJar, LWPCookieJar
from imaplib import IMAP4
from json import loads
from os import environ
from pathlib import Path
from ssl import SSLCertVerificationError, create_default_context
from time import monotonic, sleep, time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit
from urllib.request import HTTPSHandler, HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request, build_opener
import spool_fixture

HTTPS = environ.get("QS_ROUNDCUBE_FIXTURE_HTTPS") == "1"
SPOOL = environ.get("QS_ROUNDCUBE_FIXTURE_SPOOL") == "1"
SOURCE_PROOF = environ.get("QS_ROUNDCUBE_FIXTURE_SOURCE") == "1"
DISPLAY_PROOF = environ.get("QS_ROUNDCUBE_FIXTURE_DISPLAY") == "1"
PACKAGE = environ.get("QS_ROUNDCUBE_FIXTURE_PACKAGE", "")
BASE = "https://roundcube.jobs.example.test/" if HTTPS else "http://roundcube/"
BODY = b"ROUND-CUBE-FIXTURE-ORIGINAL-BODY"
ATTACHMENT = b"\x00QS-ROUND-CUBE-ATTACHMENT\xff\r\n"
OTHER_ATTACHMENT = b"\xffQS-ROUND-CUBE-OTHER-PART\x00\r\n"
REJECTION = b"Original message unavailable\n" if PACKAGE else b"Fixture reference rejected\n"
STATE = Path("/fixture-state")
CUTOVER = Path("/cutover-check")


class LoginFields(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.fields = {}
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == "input" and fields.get("type") == "hidden" and "name" in fields:
            self.fields[fields["name"]] = fields.get("value", "")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CandidateHTTPSHandler(HTTPSHandler):
    def https_open(self, request):
        def connect(host, **options):
            return HTTPSConnection(host, port=8443, **options)

        return self.do_open(connect, request, context=self._context)


def session_opener(jar, *, trust_fixture_ca=True):
    handlers = [ProxyHandler({}), HTTPCookieProcessor(jar), NoRedirect()]
    if HTTPS:
        handler = CandidateHTTPSHandler if environ.get("QS_ROUNDCUBE_FIXTURE_CANDIDATE") == "1" else HTTPSHandler
        cafile = STATE / "roundcube.crt" if trust_fixture_ca else None
        handlers.append(handler(context=create_default_context(cafile=cafile)))
    return build_opener(*handlers)


def request(opener, params, form=None):
    return request_url(opener, BASE + "?" + urlencode(params, safe="!~"), form)


def request_url(opener, url, form=None):
    status, data, _ = response(opener, url, form)
    return status, data


def response(opener, url, form=None):
    payload = urlencode(form).encode() if form is not None else None
    try:
        with opener.open(url, data=payload, timeout=10) as result:
            return result.status, result.read(), result.headers.get("Location")
    except HTTPError as error:
        with error:
            return error.code, error.read(), error.headers.get("Location")


def check(condition, description):
    if not condition:
        raise RuntimeError(description)


def wait_for_login(opener):
    startup = monotonic()
    while True:
        try:
            status, html = request(opener, {"_task": "login"})
            token = LoginFields(html.decode()).fields.get("_token")
            if status == 200 and token:
                return token
        except (URLError, ConnectionError):
            pass
        if monotonic() - startup > 40:
            raise RuntimeError("Roundcube login form did not become ready")
        sleep(0.25)


def login(account):
    opener = session_opener(CookieJar())
    token = wait_for_login(opener)
    start = monotonic()
    status, _ = request(opener, {"_task": "login"}, {
        "_task": "login", "_action": "login", "_token": token, "_url": "",
        "_user": account, "_pass": "fixture-only",
    })
    check(status in (302, 303), f"Expected stock login redirect, got HTTP {status}")
    print(f"PASS stock login {account} HTTP {status} in {monotonic() - start:.3f}s")
    return opener


class AttachmentLinks(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.links = {}
        self.source = None
        self.feed(html.decode())

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        source = fields.get("id") == "view-source"
        if tag != "a" or (not source and fields.get("class") != "filename"):
            return
        url = urljoin(BASE, fields["href"])
        target = urlsplit(url)
        check((target.scheme, target.netloc) == (urlsplit(BASE).scheme, urlsplit(BASE).netloc),
              "Unexpected guarded link origin")
        params = dict(parse_qsl(target.query))
        if source:
            check(self.source is None and params == {
                "_task": "mail", "_action": "viewsource", "_ref": params["_ref"],
            }, "Expected a single source link with an exact scoped reference")
            self.source = (url, params)
            return
        part = params["_part"]
        check(part not in self.links, "Duplicate rendered part link")
        self.links[part] = (url, params)


def reject_without_imap(session, query, label):
    journal = STATE / "imap.log"
    before = journal.read_bytes()
    status, data = request(session, query)
    check((status, data) == (409, REJECTION), f"Expected {label} rejected, got HTTP {status}")
    # A previous successful request can finish its logout after sending the HTTP body.
    old_commands = before.splitlines()
    new_commands = journal.read_bytes().splitlines()[len(old_commands):]
    check(all(command == b"LOGOUT" for command in new_commands), f"{label} touched IMAP before rejection")
    print(f"PASS {label}: HTTP 409 and zero new IMAP commands")


def check_rendered_links(opener, html, stock=False):
    links = AttachmentLinks(html).links
    check(set(links) == {"2", "3"}, "Expected two actual rendered attachment links")
    for part, (url, params) in links.items():
        check(params.get("_action") == "get", "Expected a real attachment action")
        if stock:
            check("_ref" not in params, "Stock link unexpectedly carried a signed reference")
            reject_without_imap(opener, params, f"unsigned stock link for part {part}")
            continue

        token = params.get("_ref", "")
        check(token.startswith("qs-original-v1."), "Rendered attachment reference missing")
        expected = ATTACHMENT if part == "2" else OTHER_ATTACHMENT
        start = monotonic()
        check(request_url(opener, url) == (200, expected), f"Rendered link returned wrong bytes for part {part}")
        print(f"PASS rendered link served only part {part} in {monotonic() - start:.3f}s")

        prefix, signature = token.rsplit(".", 1)
        tampered = prefix + "." + ("B" if signature.startswith("A") else "A") + signature[1:]
        reject_without_imap(opener, {**params, "_ref": tampered}, f"tampered rendered link for part {part}")
        other = "3" if part == "2" else "2"
        reject_without_imap(opener, {**params, "_part": other}, f"rendered part {part} replay on part {other}")

def check_guarded_display(opener, url, journal, section):
    expected = escape(spool_fixture.DISPLAY_TEXT.decode("utf-8")).encode("utf-8")
    query = dict(parse_qsl(urlsplit(url).query))
    html_links = None
    for case in spool_fixture.DISPLAY_CASES:
        before = len(journal.read_bytes().splitlines())
        start = monotonic()
        if case == "valid":
            with opener.open(url, timeout=10) as result:
                data = result.read()
                check(result.status == 200 and b"<pre><span>" + expected + b"</span></pre>" in data,
                      "Expected exact escaped multilingual plaintext")
                check(b"<script>" not in data and b"<img" not in data
                      and result.headers.get("Content-Security-Policy", "").startswith("default-src 'none'"),
                      "Hostile message text must be inert")
                check(set(AttachmentLinks(data).links) == {section, "3"}, "Expected only signed attachment links")
            print(f"PASS displayed {len(spool_fixture.DISPLAY_TEXT)} exact UTF-8 bytes, "
                  f"one FETCH in {monotonic() - start:.3f}s")
        elif case == "html" and SOURCE_PROOF:
            with opener.open(url, timeout=10) as result:
                data = result.read()
                html_links = AttachmentLinks(data)
                source_link = html_links.source
                check(result.status == 200 and source_link is not None
                      and source_link[1]["_ref"].split(".")[-1] == query["_source"],
                      "Expected the already-signed View source link for HTML")
                check(set(html_links.links) == {section, "3"}, "Expected both verified attachment links for HTML")
                check(b"HTML preview unavailable." in data and b"html-only" not in data
                      and b"<pre>" not in data and b"<script" not in data and b"<img" not in data
                      and result.headers.get("Content-Security-Policy", "").startswith("default-src 'none'"),
                      "HTML fallback must contain no message body or active HTML")
            print(f"PASS HTML-only body: source and attachment links, no body, one FETCH in {monotonic() - start:.3f}s")
        else:
            response = request(opener, {key: value for key, value in query.items() if key != "_source"}) \
                if case == "html-no-source" else request_url(opener, url)
            check(response == (409, REJECTION), f"{case} must release no message text or links")
            print(f"PASS display {case}: 409, no message text, one FETCH")
        commands = journal.read_bytes().splitlines()[before:]
        check(commands.count(b"UID FETCH") == 1 and b"FETCH" not in commands and b"VIEW_BODY_NATIVE_FETCH" not in commands,
              f"{case} must use only the combined guarded display FETCH")
    observed = (STATE / "display-fetch.log").read_text().splitlines()
    check(observed.count("closed-before-literal") == 1
          and [item for item in observed if item != "closed-before-literal"] == list(spool_fixture.DISPLAY_CASES),
          "Expected exact body and MIME FETCH shape, injected faults, and early close on the wire limit")
    return html_links


def check_spooled_source(opener, source_link, controls, journal):
    from imap_peer import SOURCE

    url, query = source_link
    before = len(journal.read_bytes().splitlines())
    check(request(opener, {**query, "_ref": controls["stale"]}) == (409, REJECTION),
          "A stale source epoch must release no source bytes")
    check(b"UID FETCH" not in journal.read_bytes().splitlines()[before:],
          "A stale source epoch must stop before FETCH")
    print("PASS stale source epoch: 409, no FETCH")

    for case in spool_fixture.SOURCE_CASES:
        before = len(journal.read_bytes().splitlines())
        start = monotonic()
        if case in ("valid", "fragmented-completion"):
            with opener.open(url, timeout=10) as result:
                data = result.read()
                check(result.status == 200 and data == SOURCE, "Expected exact unmodified source bytes")
                check(result.headers.get("Content-Type") == "text/plain; charset=UTF-8"
                      and result.headers.get("X-Content-Type-Options") == "nosniff"
                      and result.headers.get("Content-Length") == str(len(data)), "Expected bounded plaintext response")
            target = urlsplit(url)
            target_bytes = len(target.path) + 1 + len(target.query)
            check(target_bytes <= 4096, "Expected bounded source request target")
            print(f"PASS View source link ({case}): {target_bytes}-byte request target, one HTTP GET and one FETCH, "
                  f"{len(data)} exact bytes in {monotonic() - start:.3f}s")
        else:
            check(request(opener, query) == (409, REJECTION), f"{case} must release no source bytes")
            elapsed = monotonic() - start
            if case == "slow-completion":
                # Allow HTTP and local IMAP setup overhead around the five-second FETCH budget.
                check(4.5 <= elapsed < 6.5, f"Slow completion missed the FETCH deadline ({elapsed:.3f}s)")
            print(f"PASS source {case}: 409, no source bytes, one FETCH in {elapsed:.3f}s")
        check(journal.read_bytes().splitlines()[before:].count(b"UID FETCH") == 1,
              f"{case} must use exactly one source FETCH")
    observed = (STATE / "source-fetch.log").read_text().splitlines()
    check(observed.count("closed-before-literal") == 1
          and [item for item in observed if item != "closed-before-literal"] == list(spool_fixture.SOURCE_CASES),
          "Expected exact source FETCH shape, injected faults, and close before oversized literal")


def check_spooled_part(opener, url, journal):
    for case in spool_fixture.CASES:
        before = len(journal.read_bytes().splitlines())
        start = monotonic()
        status, data = request_url(opener, url)
        commands = journal.read_bytes().splitlines()[before:]
        check(commands.count(b"UID FETCH") == 1, f"{case} must use exactly one attachment FETCH")
        if case == "valid":
            check(status == 200 and data == spool_fixture.PAYLOAD, "Expected exact decoded attachment bytes")
            print(f"PASS spooled {len(data)} decoded bytes from {len(spool_fixture.ENCODED)} wire bytes, "
                  f"SHA-256 {sha256(data).hexdigest()}, one FETCH in {monotonic() - start:.3f}s")
        elif case == "7bit":
            check((status, data) == (200, b"ABCD"), "Verified 7bit bytes must bypass base64 decoding")
            print("PASS verified 7bit ABCD preserved byte-for-byte, one FETCH")
        elif case in spool_fixture.TRANSFER_CASES and (expected := spool_fixture.TRANSFER_CASES[case][2]) is not None:
            check((status, data) == (200, expected), f"{case} must preserve exact decoded bytes")
            print(f"PASS {case}: {len(data)} exact bytes, one FETCH")
        else:
            check((status, data) == (409, REJECTION), f"{case} must release no attachment bytes")
            print(f"PASS spool {case}: 409, no attachment bytes, one FETCH")
    observed = (STATE / "spool-fetch.log").read_text().splitlines()
    check(observed.count("closed-before-oversize") == observed.count("closed-before-oversize-mime") == 1
          and [item for item in observed if not item.startswith("closed-before-")] == list(spool_fixture.CASES),
          "Expected each wire fault and an early disconnect on the oversized declaration")


def check_session_concurrency(raw, journal, open_login, submit, *, provisioned):
    # Both handoffs are valid. Only the first browser has the detached parts in its pending URL.
    alternate = urlencode({key: value for key, value in parse_qsl(raw) if key != "_parts"}, safe="!~")
    check(alternate != raw, "Expected two distinct signed handoff URLs")
    first_jar, first, first_form = open_login(raw)
    second_jar, second, second_form = open_login(alternate)
    _, crossed, crossed_form = open_login(alternate)
    retired_jar = CookieJar()
    duplicate_jar = CookieJar()
    for cookie in first_jar:
        retired_jar.set_cookie(cookie)
        duplicate_jar.set_cookie(cookie)
    retired = next(cookie.value for cookie in retired_jar if cookie.name == "roundcube_sessid")

    gate = Path("/session-login")
    armed, entered = gate / "armed", gate / "entered"
    armed.touch()
    start = monotonic()
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(submit, first, first_form)
        try:
            while not entered.exists():
                check(not pending.done() and monotonic() - start < 5, "First login did not reach the IMAP gate")
                sleep(0.01)
            before = journal.read_bytes()
            status, data, location = submit(session_opener(duplicate_jar), first_form)
            check(status in (401, 409) and location is None and BODY not in data,
                  "Overlapping reuse of the pre-login cookie must fail")
            check(submit(crossed, crossed_form, _url=raw) == (409, REJECTION, None),
                  "Independent session must reject another session's pending URL")
            check(journal.read_bytes() == before, "Rejected concurrent POSTs must issue no IMAP command")
            contender = pool.submit(submit, second, second_form)
            if provisioned:
                contender.result(timeout=3)
                check(entered.exists() and not pending.done(), "Independent login did not overlap the first")
            else:
                try:
                    contender.result(timeout=0.5)
                except TimeoutError:
                    pass
                else:
                    raise RuntimeError("Second login completed before first-time provisioning")
                check(journal.read_bytes() == before, "Second login must wait before IMAP during provisioning")
        finally:
            armed.unlink(missing_ok=True)
            entered.unlink(missing_ok=True)
        status, data, first_location = pending.result()
        check(status == 302 and first_location == "/?" + raw and BODY not in data,
              f"First browser must resume its exact URL, got HTTP {status}")
        status, data, second_location = contender.result()
        check(status == 302 and second_location == "/?" + alternate and BODY not in data,
              f"Second browser must resume its exact URL, got HTTP {status}")
    phase = "provisioned" if provisioned else "first-time"
    print(f"PASS {phase} login overlap: duplicate and crossed POSTs rejected before IMAP, exact redirects in both browsers")

    first_cookies = {cookie.name: cookie for cookie in first_jar}
    second_cookies = {cookie.name: cookie for cookie in second_jar}
    check(len({retired, first_cookies["roundcube_sessid"].value, second_cookies["roundcube_sessid"].value}) == 3
          and first_cookies["roundcube_sessauth"].value != second_cookies["roundcube_sessauth"].value,
          "Expected two distinct authenticated sessions and a retired temporary ID")
    for opener, location, parts in ((first, first_location, True), (second, second_location, False)):
        before = len(journal.read_bytes().splitlines())
        status, data = request_url(opener, urljoin(BASE, location))
        check(status == 200 and BODY in data and bool(AttachmentLinks(data).links) == parts,
              "Each browser must read the view authorized by its exact resumed URL")
        check(journal.read_bytes().splitlines()[before:].count(b"UID FETCH") == 1,
              "Each resumed view must use one guarded FETCH")

    mixed_jar = CookieJar()
    mixed_jar.set_cookie(first_cookies["roundcube_sessid"])
    mixed_jar.set_cookie(second_cookies["roundcube_sessauth"])
    for jar in (retired_jar, mixed_jar):
        before = len(journal.read_bytes().splitlines())
        status, data, location = response(session_opener(jar), BASE + "?" + raw)
        check(status in (200, 401, 409) and location is None and BODY not in data,
              "A retired or mixed cookie pair must not read the guarded view")
        if status == 200:
            links = AttachmentLinks(data)
            check(LoginFields(data.decode()).fields.get("_token") and not links.links and links.source is None,
                  "Expected stock login with no protected links")
        check(all(command == b"LOGOUT" for command in journal.read_bytes().splitlines()[before:]),
              "A retired or mixed cookie pair must issue no IMAP command")
    print(f"PASS {phase} sessions: distinct authenticated cookies, one FETCH each, "
          f"retired and mixed cookies isolated in {monotonic() - start:.3f}s")


def check_login_resume(references, retry=False):
    journal = STATE / "imap.log"
    section = spool_fixture.SECTION if SPOOL else "2"

    opener_for = session_opener
    issued = references.get("ownerOpenOriginal")
    if issued:
        destination = urlsplit(issued)
        check((destination.scheme, destination.netloc, destination.path) == ("https", "roundcube.jobs.example.test", "/"),
              "Expected the Owner-issued Roundcube origin")
        raw = destination.query
        wait_for_login(opener_for(CookieJar()))
        release = environ.get("QS_ROUNDCUBE_FIXTURE_RELEASE")
        if release:
            opener = opener_for(CookieJar())
            with opener.open(BASE, timeout=10) as result:
                check(result.headers.get("X-Fixture-Roundcube-Release") == release
                      and LoginFields(result.read().decode()).fields.get("_token"),
                      "Expected the selected native release and stock login")
            status, data = request_url(opener, BASE + "static.php/skins/elastic/styles/styles.min.css")
            check(status == 200 and len(data) > 1024, "Expected native public static handler")
            for path in ("config/defaults.inc.php", "program/include/iniset.php", "SQL/sqlite.initial.sql",
                         "plugins/quantself_original/quantself_original.php", "vendor/autoload.php", "installer.php",
                         "static.php/config/config.inc.php", "static.php/plugins/quantself_original/quantself_original.php"):
                check(request_url(opener, BASE + path)[0] in (403, 404), f"Private release path exposed: {path}")
            print(f"PASS native {release}: public_html login and asset, eight private paths denied")
        if HTTPS:
            check(urljoin(BASE, "?" + raw) == issued, "Expected the unmodified Owner-issued HTTPS URL")
            try:
                request_url(opener_for(CookieJar(), trust_fixture_ca=False), issued)
            except URLError as error:
                check(isinstance(error.reason, SSLCertVerificationError), "Expected the untrusted TLS certificate to fail")
            else:
                raise RuntimeError("Untrusted fixture certificate was accepted")
        observations = [loads(line) for line in (STATE / "observations.jsonl").read_text().splitlines()]
        message = references["message"]
        check(len(observations) == 2 and len({value["challenge"] for value in observations}) == 2,
              "Expected distinct confirmation and issuance observations")
        for value in observations:
            check(all(value[key] == message[key] for key in ("account", "folder", "uidValidity"))
                  and len(value["matches"]) == 1
                  and all(value["matches"][0][key] == message[key] for key in ("uid", "messageId")),
                  "Dedicated observer returned a different message")
        check("attachmentParts" not in observations[0]["matches"][0]
              and observations[1]["matches"][0]["attachmentParts"] == [section, "3"],
              "Only issuance should request exact attachment evidence")
        examined = (STATE / "observer-imap.log").read_text().splitlines()
        check([verb for verb in examined if verb not in ("CAPABILITY", "LOGIN")]
              == ["EXAMINE", "UID SEARCH", "UID FETCH"] * 2,
              "Confirmation and bundled issuance should each use one SEARCH and one UID FETCH")
        print("PASS bundled API issuance used one EXAMINE, one UID SEARCH and one UID FETCH")
    else:
        login("jobs@example.test")
        show = {"_task": "mail", "_action": "show", "_ref": references["show"]["current"]}
        source = {"_task": "mail", "_action": "viewsource", "_ref": references["source"]["current"]}
        raw = urlencode(show)

    def open_login(query):
        jar = CookieJar()
        opener = opener_for(jar)
        before = journal.read_bytes()
        status, data = request_url(opener, BASE + "?" + query)
        check(journal.read_bytes() == before, "Signed-out click touched IMAP")
        check(status == 200 and BODY not in data, f"Expected signed-out stock login form, got {status}")
        if DISPLAY_PROOF and SOURCE_PROOF:
            links = AttachmentLinks(data)
            check(links.source is None and not links.links and b"html-only" not in data,
                  "Signed-out login must contain no message markup or protected links")
        fields = LoginFields(data.decode()).fields
        check(fields.get("_url") == query and fields.get("_token"), "Expected exact URL and stock CSRF field")
        return jar, opener, fields

    def submit(opener, fields, account="jobs@example.test", **changes):
        form = {**fields, "_user": account, "_pass": "fixture-only", **changes}
        return response(opener, BASE + "?_task=login", form)

    if environ.get("QS_ROUNDCUBE_FIXTURE_SESSION_CONCURRENCY") == "1":
        for provisioned in (False, True):
            check_session_concurrency(raw, journal, open_login, submit, provisioned=provisioned)
        check(not (STATE / "plain-imap.log").read_bytes(), "Concurrent sessions must use only IMAP TLS")
        return

    if retry:
        def failed_form(query):
            jar, opener, fields = open_login(query)
            old = CookieJar()
            for cookie in jar:
                old.set_cookie(cookie)

            start = monotonic()
            before = len(journal.read_bytes().splitlines())
            status, data, location = submit(opener, fields, _pass="fixture-wrong")
            updated = LoginFields(data.decode()).fields
            check(status == 401 and location is None and BODY not in data
                  and updated.get("_url") == query and updated.get("_token"),
                  f"Expected stock 401 retry form with exact protected URL, got {status}")
            check(journal.read_bytes().splitlines()[before:].count(b"LOGIN") == 1,
                  "Expected one actual wrong-password IMAP attempt")
            old_id = next(c.value for c in old if c.name == "roundcube_sessid")
            new_id = next(c.value for c in jar if c.name == "roundcube_sessid")
            check(old_id != new_id, "Expected temporary session to rotate after failed login")
            print(f"PASS stock wrong-password 401 with exact URL and rotated temporary session in {monotonic() - start:.3f}s")
            return old, opener, updated

        def reject_retry(label, opener, form, account="jobs@example.test", statuses=(409,), **changes):
            before = journal.read_bytes()
            status, data, location = submit(opener, form, account, **changes)
            check(status in statuses and location is None and BODY not in data, f"{label} returned HTTP {status}")
            check(status != 409 or data == REJECTION, f"{label} returned unexpected response bytes")
            check(journal.read_bytes() == before, f"{label} attempted IMAP credentials")
            print(f"PASS {label} HTTP {status}, no redirect or IMAP command")

        raw_source = urlencode(source)
        if retry == "controls":
            _, altered, altered_form = failed_form(raw)
            reject_retry("retry changed to another valid action", altered, altered_form, _url=raw_source)
            _, wrong_mailbox, wrong_form = failed_form(raw)
            reject_retry("retry changed mailbox", wrong_mailbox, wrong_form, account="other@example.test")

            _, ordinary, ordinary_form = open_login("_task=login")
            status, data, location = submit(ordinary, ordinary_form, "other@example.test", _pass="fixture-wrong")
            plain_retry = LoginFields(data.decode()).fields
            check(status == 401 and location is None and plain_retry.get("_token") and "_ref" not in plain_retry.get("_url", ""),
                  f"Expected stock unsigned wrong-password form, got {status}")
            status, data, location = submit(ordinary, plain_retry, "other@example.test")
            check(status == 302 and location and "_ref" not in location and BODY not in data,
                  f"Expected stock unsigned retry redirect, got {status}")
            print("PASS ordinary unsigned login retained stock 401 → retry 302")

            return

        expiring = references["retry"]
        _, timed, timed_form = failed_form(urlencode({**show, "_ref": expiring["token"]}))
        old, current, updated = failed_form(raw_source)
        reject_retry("stale temporary cookie", opener_for(old), updated, statuses=(401, 409))

        status, data, location = submit(current, updated)
        check((status, location) == (302, "/?" + raw_source) and BODY not in data,
              f"Expected exact source redirect from current retry session, got {status}")
        status, data = request_url(current, urljoin(BASE, location))
        check(status == 200 and BODY in data and b"Message-ID: <roundcube-proof@example.test>" in data
              and b'class="message-part"' not in data, "Expected raw source after retry")
        print("PASS current retry POST 302 exact source URL → GET 200 raw source")

        sleep(max(0, expiring["expiry"] - time() + 0.15))
        reject_retry("reference expired during retry", timed, timed_form)
        return

    if PACKAGE == "mixed-case-account":
        _, opener, fields = open_login("_task=login")
        before = journal.read_bytes()
        check(submit(opener, fields, account="Jobs@example.test") == (409, REJECTION, None),
              "Stock case normalization must make the configured mailbox unusable")
        check(journal.read_bytes() == before, "A legacy mixed-case row must not bypass validation before IMAP")
        print("PASS legacy mixed-case row rejected at configuration validation, zero IMAP commands")
        return
    if PACKAGE and PACKAGE != "1":
        check(PACKAGE in ("no-key", "wrong-key", "host", "audience", "spool", "mode"), "Unknown package control")
        before = journal.read_bytes()
        code, body = request_url(opener_for(CookieJar()), BASE + "?" + raw)
        check((code, body) == (409, REJECTION) and journal.read_bytes() == before,
              "Invalid staged plugin configuration must reject before IMAP")
        print(f"PASS staged plugin rejected {PACKAGE} before any IMAP command")
        return
    jar, opener, fields = open_login(raw)
    if HTTPS:
        fault = environ.get("QS_ROUNDCUBE_FIXTURE_IMAP_TLS_FAULT", "")
        plaintext = STATE / "plain-imap.log"
        if fault:
            check(fault in ("ca", "hostname"), "Unknown IMAP TLS control")
            check(submit(opener, fields)[0] == 401, "Untrusted IMAP TLS must fail the stock login")
            check((STATE / "roundcube-tls-connections.log").read_text() == "accepted\n",
                  "Expected one connection to the configured IMAP TLS peer")
            check(not journal.read_bytes() and not plaintext.read_bytes(),
                  "Rejected TLS must send no IMAP command or fall back to plaintext")
            print(f"PASS Roundcube IMAP TLS rejected {fault} before any IMAP command")
            return
        _, other, other_fields = open_login("_task=login")
        before = journal.read_bytes()
        check(submit(other, other_fields, account="other@example.test") == (409, REJECTION, None)
              and journal.read_bytes() == before, "Dedicated instance must reject other accounts before IMAP")
    old = CookieJar()
    for cookie in jar:
        old.set_cookie(cookie)
    if HTTPS:
        _, unrelated, unrelated_fields = open_login("_task=login")
        before = journal.read_bytes()
        check(submit(unrelated, unrelated_fields, _url=raw) == (409, REJECTION, None)
              and journal.read_bytes() == before, "Cross-session resume must fail before IMAP")
    if issued:
        show_query = dict(parse_qsl(raw))
        bundle_entries = show_query["_parts"].split("!")
        _, changed, changed_fields = open_login(raw)
        reordered = raw.replace(show_query["_parts"], "!".join(reversed(bundle_entries)))
        before = journal.read_bytes()
        check(submit(changed, changed_fields, _url=reordered) == (409, REJECTION, None)
              and journal.read_bytes() == before, "Changing only bundle order must fail before IMAP")
    status, data, location = submit(opener, fields)
    check(status == 302 and BODY not in data and location == "/?" + raw,
          f"Expected exact signed local redirect, got HTTP {status}")
    old_ids = {c.name: c.value for c in old}
    new_ids = {c.name: c.value for c in jar}
    check("roundcube_sessid" in old_ids and "roundcube_sessid" in new_ids
          and old_ids["roundcube_sessid"] != new_ids["roundcube_sessid"],
          "Expected Roundcube to regenerate the session cookie on login")
    if HTTPS:
        check("roundcube_sessauth" not in old_ids and "roundcube_sessauth" in new_ids,
              "Expected authentication cookie only after login")
        for cookies in (old, jar):
            session = [cookie for cookie in cookies if cookie.name.startswith("roundcube_sess")]
            check(session and all(cookie.secure and not cookie.domain_specified
                                  and cookie.has_nonstandard_attr("HttpOnly") for cookie in session),
                  "Expected Secure, host-only and HttpOnly Roundcube session cookies")
            plain = Request(BASE.replace("https:", "http:", 1))
            cookies.add_cookie_header(plain)
            check(plain.get_header("Cookie") is None, "Session cookies were attached to a plaintext request")
        before = journal.read_bytes()
        stale_status, stale_body, stale_location = submit(opener_for(old), fields)
        check(stale_status in (401, 409) and stale_location is None and BODY not in stale_body
              and journal.read_bytes() == before, "Rotated temporary session must fail before IMAP")
        print(f"PASS verified HTTPS; Secure cookies rotate and stay off HTTP; stale POST {stale_status} "
              "and cross-session POST 409 issued no IMAP commands")
    if DISPLAY_PROOF:
        html_links = check_guarded_display(opener, urljoin(BASE, location), journal, section)
        if SOURCE_PROOF:
            check(html_links is not None and html_links.source is not None, "Expected a verified HTML source link")
            for part, expected in ((section, spool_fixture.PAYLOAD), ("3", OTHER_ATTACHMENT)):
                before = len(journal.read_bytes().splitlines())
                check(request_url(opener, html_links.links[part][0]) == (200, expected),
                      f"HTML attachment {part} must return exact bytes through its signed link")
                check(journal.read_bytes().splitlines()[before:].count(b"UID FETCH") == 1,
                      f"HTML attachment {part} must use exactly one FETCH")
                print(f"PASS HTML attachment {part}: {len(expected)} exact bytes, one FETCH")
            check_spooled_source(opener, html_links.source, references["sourceControls"], journal)
        check(not plaintext.read_bytes(), "Display cases must use only the verified IMAP TLS listener")
        return
    before_show = len(journal.read_bytes().splitlines())
    status, data = request_url(opener, urljoin(BASE, location))
    show_commands = journal.read_bytes().splitlines()[before_show:]
    check(status == 200 and BODY + b" &lt;b&gt; &amp;" in data, "Expected only the authorized view after login")
    if issued:
        rendered = AttachmentLinks(data)
        links = rendered.links
        check(set(links) == {section, "3"}, "Expected both API-authorized MIME parts")
        url, params = links[section]
        show_token = show_query["_ref"]
        reject_without_imap(opener, {**params, "_ref": show_token}, "Owner show reference used for attachment")
        swapped = section + "~" + bundle_entries[1].split("~")[1] + "!3~" + bundle_entries[0].split("~")[1]
        for label, bundle in (("swapped signatures", swapped), ("duplicate part", "!".join([bundle_entries[0]] * 2)),
                              ("oversize bundle", "x" * 2672), ("oversize query", "x" * 4096)):
            reject_without_imap(opener, {**show_query, "_parts": bundle}, label)
        reject_without_imap(opener, {**params, "_parts": show_query["_parts"]}, "bundle on an attachment action")
        if PACKAGE:
            reject_without_imap(opener, {"_task": "mail", "_action": "preview"}, "unsupported packaged preview")
        legacy_query = {key: value for key, value in show_query.items() if key not in ("_parts", "_source")}
        before_legacy = len(journal.read_bytes().splitlines())
        status, legacy = request(opener, legacy_query)
        legacy_links = AttachmentLinks(legacy)
        check(status == 200 and BODY in legacy and not legacy_links.links and legacy_links.source is None,
              "Expected unchanged show-only behavior")
        legacy_commands = journal.read_bytes().splitlines()[before_legacy:]
        show_commands = [command for command in show_commands if command != b"LOGOUT"]
        check(show_commands == [command for command in legacy_commands if command != b"LOGOUT"],
              "Bundled and show-only requests must use the same IMAP commands")
        print(f"PASS bundled and show-only views each used one HTTP request and {len(show_commands)} IMAP commands")
        if SOURCE_PROOF:
            controls = references["sourceControls"]
            check(rendered.source is not None and len(show_query["_source"]) == 86, "Expected API-issued source link")
            _, source_query = rendered.source
            check(source_query["_ref"].split(".")[-1] == show_query["_source"], "Expected the Owner-issued signature")
            for label, detached in (
                ("attachment signature as source", params["_ref"].split(".")[-1]),
                ("source signature with wrong identity", controls["wrongIdentity"]),
                ("source signature with wrong expiry", controls["wrongExpiry"]),
            ):
                reject_without_imap(opener, {**show_query, "_source": detached}, label)
            reject_without_imap(opener, [*show_query.items(), ("_source", show_query["_source"])], "duplicate source input")
            reject_without_imap(opener, {**source_query, "_ref": show_token}, "show reference as source")
            reject_without_imap(opener, {**params, "_ref": source_query["_ref"]}, "source reference as attachment")
            reject_without_imap(opener, {**source_query, "_source": show_query["_source"]}, "source handoff on source GET")
            check_spooled_source(opener, rendered.source, controls, journal)
            check(not plaintext.read_bytes(), "Source cases must use only the verified IMAP TLS listener")
            return
        if SPOOL:
            check_spooled_part(opener, url, journal)
            reject_without_imap(opener, {**params, "_part": "3"}, "nested part substitution")
            check(not plaintext.read_bytes(), "Spool cases must use only the verified IMAP TLS listener")
            return
        before_download = journal.read_bytes().splitlines()
        start = monotonic()
        status, part = request_url(opener, url)
        check((status, part) == (200, ATTACHMENT), "Expected exact part 2 bytes")
        check(journal.read_bytes().splitlines()[len(before_download):].count(b"UID FETCH") == 1,
              "Expected one combined attachment UID FETCH")
        reject_without_imap(opener, {**params, "_part": "3"}, "joined part substitution")
        if HTTPS:
            check(not plaintext.read_bytes(), "Roundcube must use only the verified TLS IMAP listener")
            print("PASS Roundcube used certificate-verified IMAP TLS for login, view and part fetch")
        print(f"PASS Owner-issued query resumed after signed-out login; account={message['account']} "
              f"folder={message['folder']} uid={message['uid']} epoch={message['uidValidity']} "
              f"message-id={message['messageId']} part=2 sha256={sha256(part).hexdigest()} "
              f"download and denial in {monotonic() - start:.3f}s")
        if environ.get("QS_ROUNDCUBE_CUTOVER_PROBE") == "record":
            saved = LWPCookieJar(str(CUTOVER / "cookies"))
            for cookie in jar:
                saved.set_cookie(cookie)
                if cookie.name == "roundcube_sessid":
                    (CUTOVER / "session-id").write_text(cookie.value)
            saved.save(ignore_discard=True)
        return
    status, data = request_url(opener_for(old), urljoin(BASE, location))
    check(status == 200 and BODY not in data and LoginFields(data.decode()).fields.get("_token"),
          "Old temporary cookie must see login instead of protected content")
    print("PASS signed-out GET 200 login → POST 302 exact URL with rotated cookie → GET 200 original")

    token = show["_ref"]
    start, signature = token.rsplit(".", 1)
    tampered = start + "." + ("B" if signature.startswith("A") else "A") + signature[1:]
    for name, query in (
        ("expired signed-out reference", {**show, "_ref": references["show"]["expired"]}),
        ("tampered signed-out reference", {**show, "_ref": tampered}),
    ):
        reject_without_imap(opener_for(CookieJar()), query, name)

    for label, changes, account in (
        ("wrong mailbox login", {}, "other@example.test"),
        ("scope changed to another valid reference", {"_url": urlencode(source)}, "jobs@example.test"),
        ("scope changed with same token", {"_url": urlencode({**show, "_action": "viewsource"})}, "jobs@example.test"),
        ("submitted reference stripped", {"_url": ""}, "jobs@example.test"),
        ("submitted reference duplicated", {"_url": raw + "&_ref=" + token}, "jobs@example.test"),
    ):
        _, prover, form = open_login(raw)
        before = journal.read_bytes()
        status, data, location = submit(prover, form, account, **changes)
        check((status, data, location) == (409, REJECTION, None), f"{label} was not rejected before redirect")
        check(journal.read_bytes() == before, f"{label} attempted IMAP credentials")
        print(f"PASS {label} HTTP 409, no redirect or IMAP command")

    _, plain, form = open_login("_task=login")
    before = journal.read_bytes()
    status, data, location = submit(plain, form, _url=raw)
    check((status, data, location) == (409, REJECTION, None) and journal.read_bytes() == before,
          "A different temporary login session must not accept the same signed URL")
    print("PASS valid reference transplanted into another login session rejected before IMAP")

    _, plain, form = open_login("_task=login")
    status, data, location = submit(plain, form, "other@example.test")
    target = urlsplit(urljoin(BASE, location or ""))
    params = dict(parse_qsl(target.query))
    check(status == 302 and target.netloc == "roundcube" and params.get("_task") == "mail"
          and "_ref" not in params and BODY not in data, "Expected stock ordinary mailbox login redirect")
    status, html = request_url(plain, urljoin(BASE, location))
    check(status == 200 and BODY not in html and not LoginFields(html.decode()).fields.get("_url"),
          "Expected the ordinary inbox after login")
    print("PASS ordinary second-account login retained the stock redirect and inbox")


def check_promoted_identity_write(opener):
    release = environ["QS_ROUNDCUBE_FIXTURE_RELEASE"]
    identity = str(loads((CUTOVER / "witness.json").read_text())["identity_id"])
    edit = {"_task": "settings", "_action": "edit-identity", "_iid": identity, "_framed": "1"}
    started = monotonic()
    with opener.open(BASE + "?" + urlencode(edit), timeout=10) as result:
        fields = LoginFields(result.read().decode()).fields
        check(result.status == 200 and result.headers.get("X-Fixture-Roundcube-Release") == release
              and fields.get("_token") and fields.get("_iid") == identity,
              "Expected the existing identity form on the promoted release")
    form = {**edit, "_action": "save-identity", "_token": fields["_token"],
            "_email": "jobs@example.test", "_name": "Fixture promoted display name", "_standard": "1"}
    with opener.open(BASE + "?_task=settings", data=urlencode(form).encode(), timeout=10) as result:
        data = result.read()
        check(result.status == 200 and result.headers.get("X-Fixture-Roundcube-Release") == release
              and b"update_identity_row" in data and b"Fixture promoted display name" in data,
              "Expected the promoted release to acknowledge the stock identity save")
    return monotonic() - started


def check_cutover(probe, url):
    if probe == "preserved":
        wait_for_login(session_opener(CookieJar()))
    jar = LWPCookieJar(str(CUTOVER / "cookies"))
    jar.load(ignore_discard=True)
    opener = session_opener(jar)
    journal = STATE / "imap.log"
    before = len(journal.read_bytes().splitlines())
    started = monotonic()
    if probe == "frozen":
        for form in (None, b"_task=login&_action=login"):
            try:
                opener.open(url, data=form, timeout=10).close()
            except HTTPError as error:
                with error:
                    check(error.code == 503 and error.headers.get("Retry-After") == "5",
                          "Expected a maintenance response for both reads and writes")
            else:
                raise RuntimeError("Freeze routed a request to Roundcube")
        print(f"PASS frozen route returned 503 and Retry-After for 2 HTTPS requests (GET, POST) "
              f"in {monotonic() - started:.3f}s")
    elif probe == "stale":
        status, data = request_url(opener, url)
        check(status in (200, 401) and BODY not in data and LoginFields(data.decode()).fields.get("_token"),
              "The early clone must not authenticate the late browser")
        print("PASS early clone could not resume the late browser session")
    elif probe == "preserved":
        with opener.open(url, timeout=10) as result:
            data = result.read()
            release = environ["QS_ROUNDCUBE_FIXTURE_RELEASE"]
            check(result.headers.get("X-Fixture-Roundcube-Release") == release and BODY in data,
                  "Expected the late browser to resume on the selected release")
        attachment = AttachmentLinks(data).links["2"][0]
        check(request_url(opener, attachment) == (200, ATTACHMENT),
              "Expected the late browser to download the exact attachment")
        print(f"PASS native {release} accepted the preserved browser session and exact attachment")
        return
    elif probe == "post-promotion-write":
        elapsed = check_promoted_identity_write(opener)
        check(journal.read_bytes().splitlines()[before:] == [], "Identity settings must not reach IMAP")
        print(f"PASS promoted identity save used 2 HTTPS requests (GET form, POST save), "
              f"0 IMAP commands in {elapsed:.3f}s")
        return
    else:
        raise RuntimeError("Unknown cutover probe")
    check(all(command == b"LOGOUT" for command in journal.read_bytes().splitlines()[before:]),
          "Frozen or unauthenticated browser must not reach IMAP")


def main():
    references = loads((STATE / "references.json").read_text())
    probe = environ.get("QS_ROUNDCUBE_CUTOVER_PROBE")
    if probe and probe != "record":
        check_cutover(probe, references["ownerOpenOriginal"])
        return
    retry = environ.get("QS_ROUNDCUBE_FIXTURE_LOGIN_RETRY", "0")
    retry = retry if retry in {"1", "controls"} else None
    if references.get("ownerOpenOriginal") or retry or environ.get("QS_ROUNDCUBE_FIXTURE_LOGIN_RESUME") == "1":
        check_login_resume(references, retry=retry)
        return

    opener = login("jobs@example.test")
    show = {"_task": "mail", "_action": "show"}
    source = {"_task": "mail", "_action": "viewsource"}
    attachment = {"_task": "mail", "_action": "get", "_part": "2"}
    if environ.get("QS_ROUNDCUBE_FIXTURE_STOCK_LINKS") == "1":
        status, html = request(opener, {**show, "_ref": references["show"]["current"]})
        check(status == 200, "Expected stock attachment links in rendered message")
        check_rendered_links(opener, html, stock=True)
        return

    fault = environ.get("QS_ROUNDCUBE_FIXTURE_MID_FETCH", "0")
    native_probe = environ.get("QS_ROUNDCUBE_FIXTURE_NATIVE_PROBE") == "1"
    if fault.startswith("show-"):
        start = monotonic()
        status, data = request(opener, {**show, "_ref": references["show"]["current"]})
        native_show = environ.get("QS_ROUNDCUBE_FIXTURE_NATIVE_SHOW") == "1"
        if native_show:
            check(status == 200 and b"ROUND-CUBE-FIXTURE-UNVERIFIED-VIEW" in data and BODY not in data,
                  f"Expected changed native view bytes, got HTTP {status}")
        else:
            check((status, data) == (409, REJECTION), f"Expected guarded view rejection, got HTTP {status}")
        print(f"PASS {'native' if native_show else 'guarded'} {fault} HTTP {status} in {monotonic() - start:.3f}s")
        return
    if fault != "0" or native_probe:
        if fault.startswith("attachment"):
            status, html = request(opener, {**show, "_ref": references["show"]["current"]})
            check(status == 200, "Expected rendered attachment link before fault")
            url, _ = AttachmentLinks(html).links["2"]
            start = monotonic()
            status, data = request_url(opener, url)
        else:
            start = monotonic()
            status, data = request(opener, {**source, "_ref": references["source"]["current"]})
        if native_probe:
            check(status == 200, f"Expected native parser observations, got HTTP {status}")
            observed = loads(data)
            expected_literal = fault not in {"1", "attachment"}
            check(
                observed["returnedLiteral"] == expected_literal
                and (observed["literalBytes"] > 0) == expected_literal
                and observed["selectedEpoch"] == 120 and observed["errorCode"] == 0,
                f"Unexpected native parser metadata: {observed}",
            )
            if expected_literal and fault.startswith("attachment"):
                expected = OTHER_ATTACHMENT if fault == "attachment-wrong-section" else ATTACHMENT
                check(observed["literalSha256"] == sha256(expected).hexdigest(),
                      "Expected exact synthetic part digest")
            print(f"PASS native probe {fault}: {observed['literalBytes']} literal bytes, "
                  f"epoch {observed['selectedEpoch']}, error {observed['errorCode']} "
                  f"in {monotonic() - start:.3f}s")
            return
        print(f"Signed mid-fetch {fault} HTTP {status}, {len(data)} response bytes in {monotonic() - start:.3f}s")
        if fault == "source-at-limit":
            check(status == 200 and len(data) == 1024 and BODY in data,
                  "Expected the 1024-byte UID-last literal")
        elif fault == "attachment-reordered":
            check((status, data) == (200, ATTACHMENT), "Expected exact part bytes with reordered FETCH")
        elif environ.get("QS_ROUNDCUBE_FIXTURE_STOCK_STREAM") == "1":
            check((status, data) == (200, b""), "Expected the stock empty 200 baseline")
        else:
            check((status, data) == (409, REJECTION), "Expected 409 with no source or attachment bytes")
        return

    other = login("other@example.test")
    with IMAP4("imap-fixture", 1143, timeout=5) as peer:
        peer.login("other@example.test", "fixture-only")
        selected, _ = peer.select("INBOX", readonly=True)
        epoch = peer.response("UIDVALIDITY")[1]
        code, uids = peer.uid("SEARCH", None, "ALL")
        check(selected == code == "OK" and epoch == [b"120"] and uids == [b"42"],
              "Expected the second account to have INBOX UID 42 at UIDVALIDITY 120")
    print("PASS second account has the same INBOX UID and UIDVALIDITY")

    view_token = references["show"]["current"]
    source_token = references["source"]["current"]
    part_token = references["attachment"]["current"]
    prefix, signature = view_token.rsplit(".", 1)
    tampered = prefix + "." + ("B" if signature.startswith("A") else "A") + signature[1:]
    negative = [
        ("tampered signature", opener, {**show, "_ref": tampered}),
        ("expired reference", opener, {**show, "_ref": references["show"]["expired"]}),
        ("view replay on raw source", opener, {**source, "_ref": view_token}),
        ("view replay on attachment", opener, {**attachment, "_ref": view_token}),
        ("raw replay on attachment", opener, {**attachment, "_ref": source_token}),
        ("attachment replay on raw source", opener, {**source, "_ref": part_token}),
        ("attachment replay on another part", opener, {**attachment, "_part": "1", "_ref": part_token}),
        ("coordinate override", opener, {**show, "_uid": "42", "_ref": view_token}),
        ("duplicate reference", opener, [*show.items(), ("_ref", view_token), ("_ref", tampered)]),
        ("wrong-account view replay", other, {**show, "_ref": view_token}),
        ("wrong-account source replay", other, {**source, "_ref": source_token}),
        ("wrong-account attachment replay", other, {**attachment, "_ref": part_token}),
    ]
    for label, session, query in negative:
        reject_without_imap(session, query, label)

    raw_markers = (b"Message-ID: <roundcube-proof@example.test>", BODY, b64encode(ATTACHMENT))
    checks = (
        ("show", show, lambda data: BODY + b" &lt;b&gt; &amp;" in data),
        ("source", source, lambda data: all(marker in data for marker in raw_markers)),
        ("attachment", attachment, lambda data: data == ATTACHMENT),
    )
    for scope, action, expected_bytes in checks:
        start = monotonic()
        journal = STATE / "imap.log"
        commands_before = len(journal.read_bytes().splitlines())
        status, data = request(opener, {**action, "_ref": references[scope]["current"]})
        commands = journal.read_bytes().splitlines()[commands_before:]
        if scope == "show" and environ.get("QS_ROUNDCUBE_FIXTURE_NATIVE_SHOW") != "1":
            check(commands.count(b"VIEW_BODY_VERIFIED_FETCH") == 1 and b"VIEW_BODY_NATIVE_FETCH" not in commands,
                  "Expected exactly one guarded view body lookup and no native refetch")
        if scope in {"source", "attachment"}:
            check(commands.count(b"UID FETCH") == 1, f"Expected one combined {scope} UID FETCH")
        check(status == 200 and expected_bytes(data),
              f"Expected current signed {scope} bytes, got HTTP {status}, {len(data)} bytes")
        print(f"PASS current signed {scope} HTTP 200 in {monotonic() - start:.3f}s")

        if scope == "show":
            check_rendered_links(opener, data)
        else:
            replay = request(opener, {**action, "_ref": references[scope]["current"]})
            check(replay[0] == 200 and expected_bytes(replay[1]), f"Expected same-scope {scope} replay")
            print(f"PASS same-scope {scope} replay before expiry")

        start = monotonic()
        status, data = request(opener, {**action, "_ref": references[scope]["stale"]})
        check((status, data) == (409, REJECTION),
              f"Expected signed stale {scope} rejection, got HTTP {status}, {len(data)} bytes")
        print(f"PASS signed stale {scope} HTTP 409 in {monotonic() - start:.3f}s")


if __name__ == "__main__":
    main()
