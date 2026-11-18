# Roundcube Open original links

Offline qualification and deployment candidate for [#359](https://github.com/devdogfish/quantself/issues/359), 2026-11-17. Upstream source inspected at 1.7.6. Deployment and end-to-end behavior remain unverified. [ADR 0051](../adr/0051-three-inboxes-life-jobs-business.md)

## Evidence

- Quantself currently records one optional `sourceReply` per Job Application, containing only a folder and UID. The web lifecycle detail uses `QUANTSELF_JOBS_ROUNDCUBE_URL` to emit a bare HTTPS link. The Jobs page displays that one link. Per-reply history, recipient or Message-ID lookup, and Bot HQ links remain outside this path. [Reference schema](../../apps/api/src/jobs-lifecycle-contract.ts) · [URL builder and lifecycle detail](../../apps/api/src/jobs-lifecycle.ts) · [Web UI](../../apps/web/app/jobs/applications/jobs-applications.tsx)
- Roundcube emits `?_task=mail&_action=show&_mbox=…&_uid=…`. Use the exact IMAP folder identifier with its server hierarchy delimiter and Roundcube's modified UTF-7 representation for international names. Encode each query value once. Roundcube applies the folder to the session, and a compound UID such as `123-other-folder` overrides the folder argument. A guarded entry should accept the canonical folder and a positive 32-bit numeric UID from the verified reference. [Roundcube message view](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/show.php#L50-L98) · [Folder ID and display name](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail_action.php#L1118-L1137) · [Folder override](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/index.php#L69-L86) · [URL encoding](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail.php#L1109-L1138)
- Normal Roundcube login carries the original query through successful mailbox authentication. An existing session supplies its own active account. Tailscale controls reachability. Purelymail documents TLS IMAP on port 993 with the full mailbox address and mailbox or App Password. Opening a message can set `\Seen`; the #278 IMAP-only credential could change a flag, so protocol scope alone does not enforce read-only access. [Roundcube form](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail_output_html.php#L2269-L2305) · [Login and redirect](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/public_html/index.php#L108-L153) · [Roundcube Seen behavior](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/show.php#L158-L172) · [Purelymail settings](https://support.purelymail.com/support/solutions/articles/159000430778-server-settings-imap-smtp-pop3-and-managesieve-protocols) · [#278](https://github.com/devdogfish/quantself/issues/278)
- A UID is scoped to its account, folder and UIDVALIDITY. Moves, deletes and renames can stale a link. After UIDVALIDITY changes, a reused numeric UID can open a different message. A different account can also have the same folder and UID. A pre-redirect check leaves a gap before Roundcube uses the URL. Even on one connection, a server can invalidate UIDs in a selected mailbox and report the change asynchronously. Roundcube's `folder_data()` can return already-selected connection data. [IMAP UID rules](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.1.1) · [In-use invalidation](https://www.rfc-editor.org/rfc/rfc2683.html#section-3.4.3) · [Roundcube folder data](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_imap.php#L3677-L3704)
- #278 proved direct and Bcc delivery and preserved Application Addresses. #196 found the expected addresses in Purelymail's first SMTP `Received` field for direct and Bcc, and the bare Jobs address on its control. Both provider-looking alias fields preserved sender forgeries, including a false Application Address on the control. SES stripped the injected `Received` field, so forged trace provenance via raw SMTP remains unqualified. Sam's live scoped reader was verified separately. Keep automatic recipient-based association and writes gated on provider provenance bound to the fetched UID. Treat addresses and exact Message-IDs as lookup keys. When results are absent, ambiguous or untrusted, require a verified manual match. [#278 cutover](https://github.com/devdogfish/quantself/issues/278) · [#196 recipient tests and live reader](https://github.com/devdogfish/quantself/issues/196)

## Lookup contract

1. Authorize an Owner lookup for the specific Job Application and pin the server, Jobs account and eligible folders. A recipient lookup must use an exact issued Application Address with independently qualified delivery evidence. One address can have multiple replies; require a specific selection. An exact Message-ID lookup uses the incoming message's single parsed `Message-ID`. `In-Reply-To` and `References` identify other messages. A Message-ID is a search key, not proof of provenance. [RFC 5322 §3.6.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4) · [SMTP recipient](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.1.1.3)
2. In each eligible folder, `EXAMINE` captures UIDVALIDITY, `UID SEARCH HEADER` returns candidates, and a bounded batch of `UID FETCH BODY.PEEK[HEADER.FIELDS (...)]` returns only the required headers. Search is a substring filter; parse and compare the complete identifiers. Return distinct outcomes for one exact match, none, multiple, or incomplete evidence. An exceeded limit, unavailable folder, or truncated reply is incomplete. Keep lookup off the Jobs detail load; reuse the selected connection and batch by folder. A known-reference check needs one selection and one UID fetch after authentication, rather than a folder sweep. Measure warm and cold lookup command counts at qualification. [IMAP EXAMINE](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.3.2) · [SEARCH](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4.4) · [FETCH](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4.5)
3. On move or epoch change, invalidate the old reference first. Rebind only with trusted move evidence or independently verified identity for the new match. A matching Message-ID alone cannot prove a relocated message is the original.

## Candidate and gate

- Deploy on Atlas VM 3358 after checking capacity, listener bindings and current tailnet grants. #358 records private ports 443, 8443 and 8444 in use. Propose a separate Owner-only HTTPS port, candidate 8445 subject to preflight, with Tailscale Serve to a loopback backend, trusted TLS and Funnel off. Qualify access from the Owner Mac and iPhone plus denial from unauthorized tailnet, LAN and WAN clients. Prefer a distinct origin hostname. If using the existing hostname on a new port, prove cookie and session isolation from its other apps before enabling login; ports alone do not isolate cookies. [#358](https://github.com/devdogfish/quantself/issues/358) · [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) · [HTTP cookie security considerations](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5)
- Use the patched upstream 1.7 line. Debian 13's Roundcube package is on 1.6, and Debian OS updates do not patch an upstream install. Proposed starting point is verified upstream 1.7.6, dated November 9, including a UID-handling security fix. Check for a newer 1.7 release during preflight. Use the upstream signature and checksum, serve only `public_html/`, and automate staged, signature-verified 1.7 security upgrades. Smoke-test the guarded view before switching releases and alert on any failed verification or upgrade. Keep a known-safe release/config pair for recovery, otherwise disable the endpoint on failure. [Debian trixie packages](https://packages.debian.org/search?keywords=roundcube&source=1&suite=trixie) · [Roundcube security bulletin](https://roundcube.net/news/2026/11/09/security-updates-1.6.21-and-1.7.6) · [Signed downloads](https://roundcube.net/download/) · [1.7 document root](https://roundcube.net/news/2025/07/14/roundcube-1.7-beta-released)
- Use a dedicated Jobs Roundcube instance with the exact Jobs login allowed, fixed TLS IMAP host and an authenticated account/host check on every guarded request. The canonical account filter applies during login. A Roundcube `ready` hook can check the resulting session before dispatch. Keep the current link configuration unset until a guarded view qualifies. [Roundcube login filter](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail.php#L899-L925) · [Authenticated session fields](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail.php#L838-L850) · [Pre-dispatch hook](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail.php#L221-L259)
- Before wiring Quantself or Bot HQ, qualify a signed or opaque message reference bound to the authorized account, exact folder, UID, expected UIDVALIDITY and a verified message identity or digest. Gate access in the same Roundcube session that fetches and displays the message. Check the current selected-mailbox epoch before fetch, detect invalidation during fetch, and verify the message actually fetched before releasing headers, body or parts. Apply the same checks to source, attachment and inline part requests. A stock `ready` hook provides a pre-fetch entry point. `message_load` runs after headers and sometimes the body are fetched, and stock part URLs carry folder/UID without an epoch. These hooks alone do not establish the guarantee. Make invalid, stale or unverifiable references fail closed with a clear outcome and no bare-link fallback. Re-resolve through an authorized exact lookup after a move, with explicit ambiguity handling. [Roundcube message construction and part URL](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_message.php#L92-L152) · [IMAP invalidation](https://www.rfc-editor.org/rfc/rfc2683.html#section-3.4.3)
- Keep mail at Purelymail. Quantself stores only reference metadata. Keep Roundcube message caches disabled and sessions, temporary uploads, rendered content and message-bearing logs out of the nightly PBS snapshot. Use VM 3358's existing job for deployable Roundcube config and guard code, with ephemeral state in memory or on a separately excluded disk. Check the backup with an isolated restore and synthetic canaries in excluded state. Keep credentials in the approved Owner handoff. [#358 nightly backup](https://github.com/devdogfish/quantself/issues/358) · [Proxmox backup documentation](https://github.com/proxmox/pve-docs/blob/master/vzdump.adoc) · [VM disk backup option](https://github.com/proxmox/pve-docs/blob/master/generated/qm.1-synopsis.adoc) · [ADR 0051](../adr/0051-three-inboxes-life-jobs-business.md)

## Offline proof

Run `bun run test ./scripts/infra/mail/roundcube-original-contract.test.ts`. The 12-case [fixture](../../scripts/infra/mail/roundcube-original-contract.test.ts) shows that bare folder/UID can select an unrelated message under another account or after UID reuse. It models rejection when current server, account, folder, epoch, fetched UID or exact parsed Message-ID differs or is missing. It does not exercise Roundcube, IMAP, or a race during a real fetch.

Run `bash scripts/infra/mail/verify-roundcube-guard.sh` for the upstream hook probe. It downloads three PHP files from the Roundcube 1.7.6 commit, then uses local PHP CLI or a pinned PHP container with networking disabled. The probe runs Roundcube's dispatcher, plugin hook engine and message constructor. It supplies synthetic request checks, authenticated session values, storage, action and output. Nine cases passed on PHP 8.4.27 in 1.5 seconds after the image download.

- The dispatcher invokes `ready` after its request-security check and before mail initialization. A terminating hook stopped the wrong-account and stale-epoch cases before storage calls. Returning `abort: true` from either hook still reached the fixture renderer. [Dispatcher](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail.php#L221-L301) · [Hook engine](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_plugin_api.php#L486-L508)
- The constructor fetched headers and the fallback body before `message_load`. A terminating hook prevented the fixture renderer from running after an injected epoch change or mismatched Message-ID. A missing message returned before the hook. Stock plain source view bypasses this hook, and attachment requests need their own identity check. [Message constructor](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_message.php#L90-L152) · [Plain source view](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/viewsource.php#L29-L68) · [Attachment action](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/get.php)

Run `bash scripts/infra/mail/verify-roundcube-http.sh` for HTTP qualification. It starts digest-pinned Roundcube 1.7.6 Apache and a synthetic IMAP peer on an internal Docker network with no published ports. Two stock logins create separate authenticated sessions. An independent IMAP selection and search confirm the second account also has INBOX UID 42 at UIDVALIDITY 120. The second account deliberately serves the same synthetic bytes so the account is the condition that differs. The runner removes the containers, network and SQLite state on exit. [Official image setup](https://github.com/roundcube/roundcubemail-docker/blob/0f748dc00153d70ffaf999c5ee219480e2d5b809/apache/docker-entrypoint.sh) · [HTTP runner](../../scripts/infra/mail/verify-roundcube-http.sh)

| Stock action | Current epoch | Stale epoch | Wrong account |
| --- | --- | --- | --- |
| `show` | 200, expected message body | 409, rejection only | 409, rejection only |
| `viewsource` | 200, expected Message-ID, text and MIME attachment encoding | 409, rejection only | 409, rejection only |
| `get`, part 2 | 200, exact binary attachment | 409, rejection only | 409, rejection only |

The signed HTTP fixture passed 29 checks in 7.74 s with images present. The `ready` hook rejects duplicate or unrecognized query fields and verifies the signature, account, action and exact MIME part before connecting to IMAP. Twelve negative requests returned 409 with zero commands recorded by the peer. Separate current references returned the expected bytes for show, source and attachment. Same-scope source and attachment replays returned 200 before expiry. Signed stale references reached the epoch check and returned 409. For raw source and attachment, the bounded reader requests Message-ID and the body together on the same selected connection. It sends HTTP headers and bytes only after validating the complete body FETCH. [Bounded reader](../../scripts/infra/mail/roundcube-http-fixture/bounded_imap.php)

The stock source action sends headers before calling `print_raw_body`, which drops the fetch result. The stock attachment handler also supports streaming. The convenience body reader skips unsolicited replies and can return an already consumed literal without validating tagged completion. The fixture intercepts the two byte routes before their stock actions run. The fixture subclasses the pinned IMAP connection and replaces it before connection setup for guarded byte requests. Stock and native probe modes still use the upstream reader. [Plain source action](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/viewsource.php#L29-L68) · [Attachment handler](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail_attachment_handler.php#L168-L203) · [Convenience body reader](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_imap_generic.php#L2871-L3038)

Set `QS_ROUNDCUBE_FIXTURE_MID_FETCH` for a fault run. The peer announces UIDVALIDITY 121 after the header check and as part of the selected body FETCH. The runner verifies the peer reached that command. Each blocked request returns the exact 27-byte rejection text and releases zero message or attachment bytes. [RFC 2683 §3.4.3](https://www.rfc-editor.org/rfc/rfc2683.html#section-3.4.3)

| Mode | Peer response | HTTP result |
| --- | --- | --- |
| `1` plus `QS_ROUNDCUBE_FIXTURE_STOCK_STREAM=1` | Raw source tagged NO, no literal | 200, empty, 0.245 s |
| `1` | Raw source tagged NO, no literal | 409, 0.206 s |
| `attachment` | Part 2 tagged NO, no literal | 409, 0.187 s |
| `source-literal` | Raw source literal and tagged OK after the epoch change | 409, 0.194 s |
| `attachment-literal` | Rendered part 2 link, literal and tagged OK after the epoch change | 409, 0.192 s |

The fixture uses per-run keys, a fixed mailbox and one fixture MIME type. Production qualification still needs a response parser for provider variations, bounded buffering, and coverage of alternate message actions.

The Bun fixture issuer pre-mints separate references for parts 2 and 3. Roundcube receives those tokens and the public key. Its `template_object_messageattachments` hook replaces the stock anchors with ordinary links after checking each part from the fetched message against the signed token and the verified parent coordinates. An HTTP request to each rendered href returned only that part's exact distinct bytes in 0.188 s. Both signature tampering and swapping the two actual MIME part numbers returned 409 before IMAP access. This exercise follows the rendered href directly and covers the replacement anchor path. [Roundcube template hook](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail_output_html.php#L1459-L1468) · [Stock attachment link](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/show.php#L200-L216)

Run `QS_ROUNDCUBE_FIXTURE_STOCK_LINKS=1 bash scripts/infra/mail/verify-roundcube-http.sh` to retain the two unsigned stock anchors. Both returned 409 before IMAP access. The `attachment-literal` fault run followed the signed rendered href for part 2 and returned 409 in 0.192 s with zero attachment bytes. Production still needs an authorized exact-part issuance path. A parent show token alone provides view scope.

## Native IMAP body reader qualification

Run `QS_ROUNDCUBE_FIXTURE_NATIVE_PROBE=1 bash scripts/infra/mail/verify-roundcube-http.sh` with `QS_ROUNDCUBE_FIXTURE_MID_FETCH` set to a row below. The signed HTTP request reaches pinned Roundcube 1.7.6 and runs `handlePartBody` on the selected connection. The probe returns parser metadata and a synthetic digest. All rows took 0.18–0.19 s per measured request. [Native reader](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_imap_generic.php#L2871-L3038)

| Mode | Peer body FETCH reply | Native observation |
| --- | --- | --- |
| `0` | Requested raw literal and tagged OK | complete raw literal |
| `1` | Epoch 121 announcement and tagged NO, no literal | False, zero bytes |
| `source-literal-no` | Epoch 121 announcement, raw literal, tagged NO | complete raw literal |
| `attachment-literal` | Epoch 121 announcement, part 2 literal, tagged OK | Exact part 2 digest |
| `source-wrong-uid` | UID 43 and raw literal for request UID 42, tagged OK | complete raw literal |
| `attachment-wrong-section` | BODY[3] literal for request BODY[2], tagged OK | Exact part 3 digest |

Every native observation retained selected epoch 120 and error code 0, including the tagged failures. The native function accepts the first body literal and returns it after reaching the tagged line. It does not validate that line or bind the literal to the UID and section requested. The fixture's buffered guard independently returned 409 with zero protected bytes for all three added faults, `source-literal-no`, `source-wrong-uid`, and `attachment-wrong-section`, with native probe mode off.

The production read path still needs an IMAP response reader that preserves and checks tagged completion, unsolicited invalidation, requested UID and section, and literal completeness before HTTP output. The bounded fixture reader below qualifies guarded body FETCH for two specific synthetic response shapes.

## Bounded body FETCH qualification

The fixture requests one UID, one `BODY[HEADER.FIELDS (MESSAGE-ID)]` literal, and one nonempty `BODY[section]` literal in a single FETCH. It accepts these three attributes in any order within a single response, with one space between attributes and CRLF framing. Attribute names are case-insensitive. The reader requires the signed UID and selected UIDVALIDITY, the exact requested section, one unfolded Message-ID matching the signed value, and tagged OK for the exact command tag with no response code. Raw source must also contain the same single Message-ID in its own header block. It accepts SP/TAB folding for the ID and rejects duplicate values, comments and extra fields in the projection, and requires CRLF-delimited fields in raw headers. Lines are capped at 256 bytes and the identity literal at 320 bytes. The original HTTP comparison fixture's source path and the display path cap body literals at 1,024 bytes. Packaged source and attachments use the bounded spool. The reader checks declared sizes before reading literals, closes on unexpected framing or status, and returns no partial data to HTTP. [Literal and framing rules](https://www.rfc-editor.org/rfc/rfc9051.html#section-4.3) · [Bounded reader](../../scripts/infra/mail/roundcube-http-fixture/bounded_imap.php)

Run `QS_ROUNDCUBE_FIXTURE_MID_FETCH=<mode> bash scripts/infra/mail/verify-roundcube-http.sh` for the focused cases below.

| Mode | Peer reply | HTTP result |
| --- | --- | --- |
| `source-at-limit` | Body, identity, UID last, correct tag | 200, 1,024 bytes |
| `attachment-reordered` | Part bytes, UID, lowercase field name and folded Message-ID | 200, exact part bytes |
| `source-body-identity` | Correct projection, different Message-ID inside raw source | 409 |
| `attachment-identity` | Part bytes paired with a different Message-ID | 409 |
| `source-mixed-newline` | Duplicate Message-ID hidden behind a bare LF in raw headers | 409 |
| `source-duplicate-identity` | Conflicting Message-ID fields in projection | 409 |
| `source-split-fetch` | Identity and body in separate FETCH replies | 409 |
| `source-oversize` | Declaration of 1,025 bytes, no body sent | 409, peer observed immediate socket close |
| `source-truncated` | 23 bytes of the declared literal, then EOF | 409 |
| `source-tagged-no` | Full literal followed by tagged NO | 409 |
| `source-wrong-tag` | Full literal followed by OK with a different tag | 409 |
| `source-epoch-after` | Full literal followed by an unsolicited UIDVALIDITY change and tagged OK | 409 |
| `source-tagged-epoch` | Full literal followed by tagged OK with a UIDVALIDITY response code | 409 |

Every 409 contained only rejection text. The standard HTTP driver counts one UID FETCH each for guarded raw source and attachment, including identity retrieval. Login and mailbox selection still use Roundcube's native APIs. Release requires authorized provider qualification of actual response frames and server behavior, appropriate production size and time limits, and coverage for rendered MIME types and alternate actions beyond the fixture. Same-response identity binds the provider's label to the part, so the part still relies on the provider honoring that label. Independent byte verification would require a trusted expected digest.

## Rendered view qualification

Pinned Roundcube constructs the message from headers and MIME structure and invokes `message_load`. The stock show template later calls `get_part_body`, which fetches the part when its body is unset. The signed header check can therefore pass before a separate native body FETCH returns replacement text. The native control rendered that replacement with HTTP 200 even when the peer announced UIDVALIDITY 121 after the literal. [Message initialization](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_message.php#L108-L152) · [Body cache and fetch](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_message.php#L252-L313) · [Stock body rendering](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/actions/mail/show.php#L623-L650)

The guarded fixture accepts one displayable 7-bit US-ASCII text/plain part at section 1. During `message_load`, it checks the signed Message-ID, folder, returned header UID and MIME shape, fetches the identity and exact part in one bounded command, and places the verified literal in Roundcube's existing body cache. The fixture disables native body fallback on that connection. The real show template escaped the verified markup characters, rendered its signed attachment links, and issued one combined body FETCH with no native body refetch. This covers the fixture's ASCII text path. Header and MIME structure retrieval still use upstream APIs, and HTML, other encodings, inline images, and alternate view actions remain outside the qualification.

| Run | Injected response | Result |
| --- | --- | --- |
| `QS_ROUNDCUBE_FIXTURE_NATIVE_SHOW=1 QS_ROUNDCUBE_FIXTURE_MID_FETCH=show-epoch` | Same-length replacement text, then unsolicited epoch 121 | 200 with replacement text |
| `QS_ROUNDCUBE_FIXTURE_MID_FETCH=show-epoch` | Same-length replacement text, then unsolicited epoch 121 | 409, rejection text only |
| `QS_ROUNDCUBE_FIXTURE_MID_FETCH=show-identity` | Same-length replacement text with the other Message-ID in the same FETCH | 409, rejection text only |
| `QS_ROUNDCUBE_FIXTURE_MID_FETCH=show-header-uid` | Native header and MIME FETCH reports UID 43 for the signed UID 42 | 409, rejection text only |

Pass each environment configuration to `bash scripts/infra/mail/verify-roundcube-http.sh`. The runner verifies that the peer reached the body fault. Production view qualification still needs a verified header and MIME metadata path, supported MIME decoding, and provider behavior checks before exposing a guarded view.

## Signed reference contract

The standalone PHP verifier accepts `qs-original-v1.<payload>.<signature>`. Both segments use unpadded base64url. Ed25519 signs the ASCII version and encoded payload joined by a dot. The payload is a fixed JSON tuple of audience, account, exact folder, UID, UIDVALIDITY, Message-ID, scope, MIME part, issued time and expiry. A tuple avoids duplicate claim names. UID and UIDVALIDITY are positive unsigned 32-bit integers. Message-ID accepts a single angle-bracketed ASCII ID with dot-atom local part and domain. The lifetime is at most five minutes. `show` and `source` require a null MIME part and `attachment` requires the exact canonical part. [Verifier](../../scripts/infra/mail/roundcube-reference/verify.php) · [PHP Sodium](https://www.php.net/manual/en/function.sodium-crypto-sign-verify-detached.php)

The Roundcube side needs only a configured public key. A future adapter must authenticate the Owner, supply the audience and active mailbox account from trusted context, reject duplicate reference parameters and coordinate overrides, and verify the reference before opening storage. Use only the returned folder and UID for lookup, compare UIDVALIDITY and message identity against the fetch, and verify the complete fetch before releasing data. The tokens are readable and replayable until expiry, so keep them out of logs and cross-origin referrers. The disposable HTTP fixture exercises this integration with a per-run Bun signer and a public key mounted into Roundcube.

Run `bun scripts/infra/mail/verify-roundcube-reference.ts`. The script generates disposable Ed25519 keys in memory with Bun and sends the public key and synthetic references to the pinned image's PHP CLI with container networking disabled. All 26 checks passed, including tampering, expiration, account or action mismatch, and ambiguous coordinates. [Runner](../../scripts/infra/mail/verify-roundcube-reference.ts)

## Owner issuance seam

`issueRoundcubeOriginal` accepts an existing authenticated web Owner context with `jobs:read` and the Job Application ID. Its injected adapter gets one owner-scoped lookup request. The adapter must return the verified application association and a complete, exact current mailbox observation. Incomplete results and unqualified recipient evidence must come back as unavailable. The issuer rejects multiple matches, missing evidence, and changes in the folder, UID, UIDVALIDITY, account, or Message-ID. It requires an observation from the current lookup and within five seconds of issuance. An accepted match produces an HTTPS show URL whose Ed25519 reference expires after two minutes. [Callable issuer](../../apps/api/src/roundcube-original-issuer.ts)

The current lifecycle `sourceReply` contains folder and UID for history. Issuance requires an Owner-confirmed application association with mailbox account, folder, UID, UIDVALIDITY and Message-ID. The adapter defaults to disabled, restricts IMAP to the configured account's INBOX, and challenges each mailbox observation to reject replay. Recipient traces and thread matches cannot establish the association. [Lifecycle contract](../../apps/api/src/jobs-lifecycle-contract.ts) · [Association adapter](../../apps/api/src/roundcube-original-association.ts)

The confirmation store requires an authenticated web Owner with `jobs:write` and a fresh, exact mailbox observation. It appends only association metadata to owner- and application-scoped JobEvents. Replaying the current confirmation returns its saved revision. A stale replacement conflicts, and concurrent replacements from the same revision produce one write. Issuance reads the scoped event before IMAP and checks the same event after IMAP. The existing compound index supplies the latest event from its confirmation key range. The disposable PostgreSQL test covers process restart, cross-Owner access, replacement during issuance, and issuance through the loopback IMAP worker. The pinned PHP verifier accepted the resulting link and rejected it for a different account and at expiry. Run `QUANTSELF_ROUNDCUBE_STORE_FIXTURE=1 bun run test ./apps/api/src/roundcube-original-store-docker.test.ts` against a migrated Docker database named `roundcube_association_fixture` on a published loopback port. [Store](../../apps/api/src/roundcube-original-store.ts) · [Database proof](../../apps/api/src/roundcube-original-store-docker.test.ts)

The local proof authenticates against the synthetic TCP peer, examines INBOX read-only, searches for Message-ID candidates and fetches their UID and projected header with one PEEK. It uses the Jobs mailbox parser, checks complete candidate coverage and compares the exact header. A valid association issues after one EXAMINE, one UID SEARCH and one batched UID FETCH. Two matching messages are ambiguous, an epoch change aborts before FETCH, and a different authenticated account with identical coordinates cannot issue. Run `bun run test ./apps/api/src/roundcube-original-association.test.ts`. [Fixture worker](../../scripts/infra/mail/roundcube-association-fixture/observe.py) · [Tests](../../apps/api/src/roundcube-original-association.test.ts)

## Private mailbox observer

The dormant observer uses the existing Jobs account and IMAP host. TLS validates the CA chain, exact hostname and configured SHA-256 leaf certificate pin before LOGIN. It projects one Message-ID header per candidate, limits an observation to eight candidates and 8 KiB of replies, and allows three seconds for the IMAP exchange. The one-shot socket process has a four-second deadline. It withholds the entire observation on incomplete results, mailbox changes, or failed authentication. [IMAP observer](../../agents/sam/jobs-mail/roundcube_imap.py)

The API factory requires `QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED=1`, the existing HTTPS `QUANTSELF_JOBS_ROUNDCUBE_URL`, `QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET` and `QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT`. The socket and parent directory must be controlled by the deployment operator. The worker checks the Linux peer UID against `QUANTSELF_JOBS_ROUNDCUBE_PEER_UID`, reads its pin from `QUANTSELF_JOBS_ROUNDCUBE_IMAP_CERT_SHA256` and obtains `imap` from its private systemd credential directory. Qualify the socket ownership, peer UID, provider chain and pin, provider search behavior and credential scope before launching the worker or enabling the routes. [Privileged entry point](../../agents/sam/jobs-mail/jobs_roundcube_observer.py) · [API assembly](../../apps/api/src/roundcube-original-private.ts)

Run `python3 -B agents/sam/jobs-mail/test_roundcube_observer.py` and `bun run test ./apps/api/src/roundcube-original-private.test.ts`. The disposable Unix socket and TLS peer exercise the API through issuance plus hostname, CA, pin, account, stale challenge, incomplete fetch, and reply-limit failures. The success uses two scoped database reads around one EXAMINE, one SEARCH and one batched FETCH. [TLS fixture](../../agents/sam/jobs-mail/test_roundcube_observer.py) · [API proof](../../apps/api/src/roundcube-original-private.test.ts)

The internal store lookup can opt into `includeAttachmentParts`. The socket query then specifies `attachmentUid` from the Owner-confirmed association. It adds BODYSTRUCTURE to the same batched UID FETCH. Only a unique exact match at that UID returns part IDs. Discovery returns at most 16 numeric paths of at most eight levels for explicit attachment leaves. It skips inline parts, named or attached multipart containers, and encapsulated messages. The 8 KiB total IMAP budget and 320-byte literal limit still apply. The opt-in allows a 4 KiB response line to accommodate multipart metadata. Only part IDs cross the socket. Current confirmation and show callers use the identity-only request. Attachment token handoff remains separate. [Observer](../../agents/sam/jobs-mail/roundcube_imap.py) · [IMAP BODYSTRUCTURE and part numbering](https://www.rfc-editor.org/rfc/rfc3501.html#section-6.4.5)

### Observer deployment package

Stage on a disposable checkout with `agents/sam/jobs-mail/roundcube-observer-deploy/stage.sh NEW_ABSOLUTE_STAGE_DIR API_HOST_UID SOCKET_HOST_GID IMAP_LEAF_SHA256`. It writes only the new directory. For an approved installation, copy the staged files to their corresponding absolute paths as root:root. Use mode `0644` for the unit, socket drop-in and Python files, `0600` for `observer.env` and `0700` for its directory. Run `systemd-analyze verify` on the installed socket and service template before a separate activation. Keep the route flag unset through trust qualification. The unit uses a dynamic worker UID, at most two accepted connections, a five-second service lifetime and a separate credential namespace. [Staging command](../../agents/sam/jobs-mail/roundcube-observer-deploy/stage.sh) · [Service](../../agents/sam/jobs-mail/roundcube-observer-deploy/quantself-roundcube-observer%40.service) · [Socket](../../agents/sam/jobs-mail/roundcube-observer-deploy/quantself-roundcube-observer.socket)

1. **Peer identity.** Use the Linux host running the serving API process. Record the process's effective host UID and effective or supplementary GID from `/proc/API_PID/status` as seen by the observer host. For a container, use the host PID of the serving process and account for its user namespace. Require a non-root API UID and the dedicated socket GID. Qualify API operation under those IDs before enabling this feature. Stage them as the exact UID and GID. At activation, verify `/run/quantself-roundcube-observer` is `root:root 0755` and `observe.sock` is `root:SOCKET_HOST_GID 0660`. Give the API only this observer directory, mounted read-only if containerized, and point `QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET` at its socket from the API namespace. Check that the mount still sees the socket after its inode is replaced. An unrelated group must fail at connect, and a different UID in the socket group must receive a null observation. [systemd socket controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html)
2. **Credential injection.** After the approved Owner handoff, encrypt the dedicated IMAP app password on the approved observer host with `systemd-creds encrypt --name=imap --with-key=host - "$PENDING_ENCRYPTED_FILE" < "$OWNER_PRIVATE_IMAP_INPUT"`. Use a new output path in a root-only directory. Install the encrypted result as `/etc/quantself-roundcube-observer/imap.cred` with `root:root 0600` and keep the containing directory at `0700`. systemd loads exactly that file as `$CREDENTIALS_DIRECTORY/imap` for the one-shot worker. The API holds the signing key separately. Verify permissions with `stat` and check a synthetic observer activation before the Owner's credential window. [systemd credential isolation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials) · [systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
3. **Pin rotation.** Qualify the approved host's TLS chain and hostname, then record the independently verified SHA-256 of its leaf certificate DER. Stage the new pin with the same API UID and socket GID. During the approved window, disable issuance, stop the observer socket and confirm its instances have drained. Replace only `observer.env` atomically in its root-only directory and verify its owner and mode. Start just the observer socket, then check the permitted and denied UID paths and qualified mailbox observation before enabling issuance. Keep the previous config as rollback evidence. Restore its pin only while it matches the verified endpoint. Keep issuance disabled if either trust input is unavailable.
4. **Rollback.** Clear the opt-in and verify the Owner original route returns no redirect. Stop the observer socket and verify its instances are inactive and the socket is absent. After two minutes, verify the last issued reference has expired. Verify the existing Sam Jobs socket and Quantself API health separately. Retain the association records and the previous staged config.

The isolated Linux fixture runs the staged worker entry point with real Unix peer UIDs, a root-owned socket and a worker-only synthetic `imap` file. It covers group denial, same-group wrong-UID denial, root peer denial, inaccessible or missing credentials, pin change and rollback. [Linux fixture](../../agents/sam/jobs-mail/roundcube-observer-deploy/verify-linux.py)

```sh
docker run --pull=never --rm --network none --read-only --cap-drop ALL \
  --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --mount "type=bind,src=$PWD/agents/sam/jobs-mail,dst=/fixture/agents/sam/jobs-mail,readonly" \
  --mount "type=bind,src=$PWD/agents/vaultwarden/mail.py,dst=/fixture/agents/vaultwarden/mail.py,readonly" \
  python:3.13-slim python3 -IB /fixture/agents/sam/jobs-mail/roundcube-observer-deploy/verify-linux.py
```

The native activation fixture qualified the exact rendered units on Debian 13 systemd `257.13-1~deb13u1`. The socket activated the packaged worker, injected a synthetic host-encrypted credential under its dynamic UID, rejected root and other UIDs before any IMAP command, and authenticated the API UID against loopback TLS. After changing the peer certificate, the old pin failed closed. Atomic pin replacement and `daemon-reload` kept the socket inode and permitted the new certificate. Stop removed the socket and left no active instances. Restoring the old config reopened the old synthetic peer. `systemd-analyze verify` passed on the installed fixture units. Deployment still requires the approved host's mapped IDs, socket bind mount, credential scope and provider TLS qualification. [Native activation fixture](../../agents/sam/jobs-mail/roundcube-observer-deploy/verify-systemd.py)

Run the native fixture in a fresh disposable Docker Linux container with Debian systemd, `/usr/bin/python3`, OpenSSL and the Debian CA tools. Use `--network none --add-host imap.purelymail.com:127.0.0.1 --cgroupns private --cap-add SYS_ADMIN --cap-add SYS_PTRACE --tmpfs /run --tmpfs /tmp`. Before starting PID 1, assert `/proc/self/cgroup` is `0::/`, mount cgroup2 inside the container, and run `mount --make-rshared /` inside its mount namespace. Start `/lib/systemd/systemd --unit=basic.target`. Copy `agents/sam/jobs-mail` and `agents/vaultwarden/mail.py` into the equivalent paths under `/fixture`. Execute `QS359_SYSTEMD_FIXTURE=1 python3 -IB /fixture/agents/sam/jobs-mail/roundcube-observer-deploy/verify-systemd.py`. The container's default private mount propagation hid the credential mount from the worker during the first runs. Shared propagation inside the isolated container allowed the exact unit to run. [systemd mount setup](https://github.com/systemd/systemd/blob/main/src/shared/mount-setup.c)

### Review phase — Keep observer only

**Scope.** Qualify one bounded observation on Keep VM 2541 (`quantself`), the serving API's Linux host. Keep issuance disabled throughout and end with the dedicated observer stopped. Atlas VM 3358 remains the intended Roundcube browser host and is outside this phase. The Unix peer check ties the observer to Keep. [Keep cutover evidence](https://github.com/devdogfish/quantself/issues/209#issuecomment-6898372932) · [Atlas apps VM](https://github.com/devdogfish/quantself/issues/358)

| Check | Evidence and next action |
| --- | --- |
| Provider hostname and public CA | Verified November 17, 2026 at 16:48 Halifax. macOS OpenSSL and stock Debian Python verified `imap.purelymail.com:993` over TLS 1.3 and saw the same leaf. The chain was Let's Encrypt YR1 → ISRG Root YR → ISRG Root X1. The hostname matched `*.purelymail.com`. The leaf expires January 2, 2027 at 00:54:53 UTC. Both checks ended at TLS. [Provider settings](https://support.purelymail.com/support/solutions/articles/159000430778-server-settings-imap-smtp-and-pop3) |
| Candidate leaf SHA-256 | `e0599f1d0a36d45c19e65322d03fbdb37550da4dc106327de1ce91664e1bc860`. The Debian preflight accepted this value and rejected a mismatched pin. Recheck from Keep with its system CA store before staging. Workstation Python's default store had zero CAs and failed; macOS OpenSSL's trust store verified. [TLS preflight](../../agents/sam/jobs-mail/roundcube-observer-deploy/preflight-tls.py) |
| Socket and credential mechanics | Exact rendered units passed disposable systemd activation, UID checks, pin reload and rollback. Live Keep validation is pending. [Native fixture](../../agents/sam/jobs-mail/roundcube-observer-deploy/verify-systemd.py) |
| API identity | Verified read-only on Keep VM 2541 on November 17, 2026. `quantself-blue-api-1` published `127.0.0.1:13001` to 3001. The Bun process holding port 3001, guest PID 3519408, had effective UID/GID `0:0` in the guest's initial user namespace, identity UID/GID mappings and effective `CAP_SETUID` and `CAP_SETGID`. Candidate UID `41001` and socket GID `41002` and group name `quantself-roundcube-observer` were unassigned. No process used GID `41002`. Direct API socket access hits the root-denial gate. Recheck identities against the exact admitted release. |

1. **Read-only preflight on Keep.** Confirm the reviewed release and active API slot. List the API processes with `docker top "$API_CONTAINER" -eo pid,uid,gid,comm`. Run `nsenter --target "$API_INIT_HOST_PID" --net ss -H -lntp 'sport = :3001'` to identify the listener, then check its `Uid:`, `Gid:`, `Groups:`, `uid_map` and `gid_map` from the guest. The process opening the observer socket must map to the approved non-root UID and have the dedicated GID. Qualify the narrow client release below before scheduling the credential window. Check `curl --fail --silent "http://127.0.0.1:$ACTIVE_API_PORT/api/health"` and confirm the observer socket is absent. From the checked-out candidate on Keep, run `python3 -IB agents/sam/jobs-mail/roundcube-observer-deploy/preflight-tls.py --expect-leaf CHECKED_LEAF_SHA256` with the reviewed digest. Stop on a trust or identity mismatch. Use the same Linux Python and CA store as the worker.
2. **Named approval and Owner handoff.** After preflight, seek one approval for only the Keep VM 2541 observer install, temporary socket start, one synthetic Jobs INBOX identity check and teardown. The Owner creates a dedicated temporary IMAP-only App Password for the Jobs account in Purelymail Account Admin, enters it through the approved private handoff, and encrypts it as `imap` on Keep using the command above. The Owner supplies the exact account, INBOX UIDVALIDITY, UID and Message-ID for one synthetic message, verified independently of Quantself's legacy fields. The operator checks file metadata only. The Owner's later Atlas Roundcube browser credential and Keep API Ed25519 signing key have separate handoffs and are outside this phase. [Owner credential boundary](https://github.com/devdogfish/quantself/issues/217)
3. **Exact live checks in that approved window.** Stage with the verified host UID, socket GID and leaf. Run `systemd-analyze verify` on the installed socket and service, then `systemctl daemon-reload` and `systemctl start quantself-roundcube-observer.socket`. Check the directory and socket modes with `stat -c '%u:%g %a' /run/quantself-roundcube-observer /run/quantself-roundcube-observer/observe.sock`, expecting `0:0 755` and `0:SOCKET_HOST_GID 660`. Use the [native fixture client](../../agents/sam/jobs-mail/roundcube-observer-deploy/verify-systemd.py) protocol for the live probe. Connect as the exact mapped UID and GID, send one JSON line containing a new UUIDv4 `challenge`, `folder: "INBOX"`, the canary `uidValidity` and `messageId`, then read one bounded line. Require the same challenge, account, folder and epoch, with one match at the independently known UID and Message-ID. Repeat as root or a different UID in the socket group and require `null`. An unrelated group must fail to connect. Record status and timing only. The application route stays disabled.
4. **Exit and rollback.** Stop `quantself-roundcube-observer.socket`; verify inactive, no active matching `quantself-roundcube-observer@*.service` instances, and no socket path. The Owner revokes the temporary App Password. Remove only the temporary encrypted credential and staged files named in the approval, and reload systemd if the staged unit files were removed. Verify Quantself API health and the prior Sam Jobs service baseline. Issue activation, private Roundcube ingress and provider mail behavior outside this one synthetic observation require their own reviewed phases.

The reviewed Keep overlay selects `QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT=dedicated` and defaults issuance to `0`. It requires existing read-only mounts for the observer directory and the separate root-owned signing file. Configure the host signing path with `QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_HOST_FILE` after the Owner's approved handoff. The dedicated path only accepts `/run/quantself-roundcube-observer/observe.sock`. Verify the directory bind sees a replaced socket inode after rotation. Apply the overlay only in the approved release. [Keep overlay](../../compose.roundcube-observer.yaml)

The API uses Alpine `su-exec` to start one fixed command as numeric UID/GID `41001:41002` with an empty environment. The child verifies its effective IDs and forwards a single JSON line. The request and response caps are 1 KiB and 4 KiB, stderr is discarded and the 4.25-second deadline includes child startup. Opening an original still verifies the exact message over fresh TLS and signs in the root API. The dedicated routes require the signing file to be root-owned and inaccessible to group and others. Disabled and lifecycle reads launch zero children. In pinned Bun 1.3.14, `node:child_process`'s `spawn` and `spawnSync` both ran the test child as root when given `uid` and `gid`. [Transport](../../apps/api/src/roundcube-observer-transport.ts) · [Child](../../apps/api/src/roundcube-observer-client.ts)

The disposable pinned-image proof admitted the dedicated child over a read-only host bind and issued after one EXAMINE, one SEARCH and one batched FETCH. The child could not access the synthetic root-only signing file. Root, an unexpected peer UID, a missing credential, an oversized reply, an absent socket and a stalled peer produced no signed link. The local successful read took about 90 ms including process startup and loopback TLS. The stalled case returned at 4.25 seconds. Running the whole API non-root would also require qualifying auth and signing file access, writable media and capture volumes, health checks and rollback. Next, qualify the exact deployed image and socket mount on Keep in the reviewed window. [Disposable client proof](../../agents/sam/jobs-mail/roundcube-observer-deploy/verify-api-client.sh)

## Owner Jobs route

The existing Jobs lifecycle response includes the advisory `verifiedOriginalReplyAvailable` boolean. A configured web Owner read checks confirmation with one scoped database query in parallel with the lifecycle read. Disabled and non-web reads skip that query. The drawer makes no extra request and opens the same-origin original-reply route on click. That route performs a fresh observation and returns a 303 to Roundcube only when it can issue the signed link. Legacy coordinates still mark history and supply no link in the drawer. [Lifecycle read](../../apps/api/src/jobs-route.ts) · [Drawer control](../../apps/web/app/jobs/applications/job-original-reply.tsx)

The Owner reads the confirmation revision at `GET /api/owner/jobs/applications/{id}/original-reply/confirmation` and confirms through a same-origin JSON PUT to that path with `expectedRevision` and the exact `message` identity. A retry uses the same revision and identity. Reads require `jobs:read` and confirmation requires `jobs:write`. The route also requires an absolute `QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE` path and reads its Ed25519 PEM only during issuance. Link responses carry private no-store and no-referrer headers. The disposable route proof uses the normal Owner ingress and real PostgreSQL with the loopback TLS observer. Run `QUANTSELF_ROUNDCUBE_ROUTE_FIXTURE=1 bun run test ./apps/api/src/roundcube-original-route-docker.test.ts` against a migrated Docker database named `roundcube_route_fixture` on a published loopback port. [Routes](../../apps/api/src/roundcube-original-route.ts) · [Route proof](../../apps/api/src/roundcube-original-route-docker.test.ts)

For a new reply, the Owner verifies the application association, copies the exact Message-ID from the original mail headers, and selects **Confirm original** in the application drawer. The drawer sends a same-origin JSON `PUT /api/owner/jobs/applications/{applicationId}/replies/confirmation` with `{"messageId":"<fixture@example.test>"}`. The trusted observer resolves exactly one match in the configured Jobs INBOX and captures its UIDVALIDITY from EXAMINE. Confirmation returns only the opaque reply ID. Exact retries return the same ID. The private endpoint also accepts an independently verified exact `message` tuple, and rejects coordinates that conflict with an existing confirmation.

Qualify the updated observer package with the API release before using Message-ID confirmation. The socket's `mode: "resolve"` request uses the same account, TLS trust and bounded exact-header search. Open and reverify requests still supply an expected epoch.

The lifecycle response fetches the latest 20 confirmations with legacy availability in one database read. Each row carries only the opaque reply ID and confirmation time. **Older replies** calls `GET /api/owner/jobs/applications/{applicationId}/replies?before={replyId}` for the next page. Its cursor resolves to the scoped confirmation time and ID, which also orders ties. The drawer shows one page at a time. No mailbox history is inferred from lifecycle pointers, Agent audits or matcher results.

The Owner opens a specific reply through `GET /api/owner/jobs/applications/{applicationId}/replies/{replyId}/original`. The server scopes both IDs to the Owner, rechecks the current mailbox identity and signs a two-minute redirect. Missing or mismatched IDs return 404. Stale or unverifiable evidence returns 503. Neither exposes a redirect. Roundcube refuses expired references. Existing application-wide confirmations and unverified lifecycle pointers retain their behavior. [Reply route proof](../../apps/api/src/roundcube-replies-route-docker.test.ts)

Run `bun run test ./apps/api/src/roundcube-original-issuer.test.ts` for the 17 synthetic issuer checks. `bun scripts/infra/mail/verify-roundcube-reference.ts` passes the real issuer's token to the same PHP verifier used by the Roundcube fixture. Its 29 cases passed. The issuer token verifies for the correct account and fails at expiry and on another account. The pinned PHP image runs with no network and no image pull. [Issuer checks](../../apps/api/src/roundcube-original-issuer.test.ts) · [Cross-runtime runner](../../scripts/infra/mail/verify-roundcube-reference.ts)

## Signed-out click and login resume

Run `QS_ROUNDCUBE_FIXTURE_LOGIN_RESUME=1 bash scripts/infra/mail/verify-roundcube-http.sh`. A fresh cookie jar follows the top-level signed show URL. Roundcube's stock login form returns 200 with its CSRF field and the exact query in `_url`. Submitting the form with the Jobs mailbox credentials rotates the session cookie and returns 302 to that exact relative URL. Following it with the new cookie renders the authorized message with 200. The old cookie receives the login form. The run took 4.27 s including setup and cleanup. [Stock form](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail_output_html.php#L2274-L2305) · [Stock login and redirect](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/public_html/index.php#L100-L153)

The fixture validates the signed GET before binding its raw query to the temporary session. The startup hook copies the pending query into request-local state before core destroys that session. Before IMAP authentication, the fixture compares the posted URL byte for byte, revalidates the reference and checks the submitted mailbox and selected IMAP host. It verifies the real authenticated account and host again after login. The fixture issues the checked relative redirect explicitly because the stock helper adds its own `_token`. [Startup and authentication order](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/public_html/index.php#L89-L153) · [Core token insertion](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/include/rcmail.php#L1142-L1153)

Expired and tampered signed-out references returned 409 before IMAP. The wrong mailbox login, changing scope with the same token, substituting a valid source reference, stripping or duplicating the URL reference, and transplanting it to another temporary session returned 409 with no redirect or IMAP command. Ordinary second-account login retained stock authentication and its inbox redirect and loaded the ordinary inbox. The pending login is session-bound. An already authenticated account can still use its matching signed action until expiry. This covers the disposable top-level form path. Production still needs private TLS and ingress qualification, proxy and cookie behavior, and validation on the deployed session store.

### Joined Owner issuance and Roundcube proof

Run `bash scripts/infra/mail/verify-roundcube-http.sh --prepare-joined` to stage dependencies, then `bash scripts/infra/mail/verify-roundcube-http.sh --joined` from the committed checkout. The run uses an internal Docker network without published ports. The Owner API confirms the application in PostgreSQL and issues a 303 after a fresh observation through the dedicated UID and a pinned TLS listener. Roundcube logs into the same synthetic mailbox and resumes the exact issued query over the internal HTTP fixture transport.

The joined check matches `jobs@example.test`, INBOX, UID 42, UIDVALIDITY 120 and `<roundcube-proof@example.test>` across both observations and the signed reference. With `QUANTSELF_JOBS_ROUNDCUBE_ATTACHMENT_PARTS_ENABLED=1` the API signs each verified part using the same identity and expiry. The existing v1 show token is unchanged. The optional `_parts` value lists `part~signature` entries separated by `!`, with at most 16 entries and 2,671 bytes. The signer caps the bundled request target at 4,096 bytes. Roundcube verifies the parent, reconstructs each child's v1 payload from the original JSON bytes, and verifies each signature before mailbox access. The API keeps the private key. The older show-only URL still renders without signed attachment links.

The fixture's Owner 303 carried a 177-byte bundle for parts 2 and 3 in a 494-byte query. The fixture feeds Roundcube only the public key and the issued URL. Issuance used one EXAMINE, one UID SEARCH and one batched UID FETCH. Roundcube downloaded MIME part 2 in one combined UID FETCH with SHA-256 `b8ecef4c510a2a8369a37ba70ae0817275405d9ac8aad6e8a67c9fea3a07ab08`. Swapped signatures, duplicate IDs, oversize input, and changing the requested part returned 409 before IMAP. Reordering otherwise valid bundle entries during login failed the temporary session's exact query comparison before IMAP.

Run the same runner with `--joined-https` after preparation. Pinned Caddy serves the exact Owner-issued hostname inside the same internal network. The HTTP client validates the fixture certificate and hostname, and rejects that certificate with default trust. Roundcube trusts forwarded HTTPS only from the fixture proxy. The client verifies a rotated session ID, Secure host-only HttpOnly session cookies, and suppression of those cookies for HTTP. Stock login preserves the exact resume query. A stale temporary session POST returns 401 and a POST carrying the signed URL in a different temporary session returns 409. Both return before a new IMAP command.

Live qualification still needs the deployed private HTTPS route and proxy trust, real browser and session-store behavior, and the PurelyMail authentication and fetch path.

### Dedicated Roundcube IMAP transport

The joined HTTPS run gives the Roundcube instance its own certificate-verified IMAP listener. The API observer still uses its separate pinned TLS connection. The [mailbox policy](../../scripts/infra/mail/roundcube-reference/mailbox.php) requires an exact Jobs account and fixed implicit-TLS host and port. It requires certificate and hostname verification and checks the account, host, port and TLS mode again on each guarded request. The production configuration must supply the approved provider endpoint and trust store. The isolated run supplies a synthetic certificate and mounts its public certificate in Roundcube. The IMAP, HTTPS and reference signing private keys stay in their respective services.

Run `bash scripts/infra/mail/verify-roundcube-http.sh --joined-https` for login, guarded view and exact part fetch over TLS. Repeat with `QS_ROUNDCUBE_FIXTURE_IMAP_TLS_FAULT=ca` and `QS_ROUNDCUBE_FIXTURE_IMAP_TLS_FAULT=hostname` to remove trust for the synthetic certificate or connect through a hostname outside its SAN. Each control reaches the TLS listener once and rejects before IMAP commands. A separate plaintext listener catches fallback. The joined proof denies a second mailbox at login before IMAP.

### Verified attachment spool

Run `QS_ROUNDCUBE_FIXTURE_SPOOL=1 bash scripts/infra/mail/verify-roundcube-http.sh --joined-https`. The API issues a signed reference for nested part `2.1`. Roundcube reads the exact section, its `.MIME` header and Message-ID in one UID FETCH. A five-second FETCH read budget covers validation through tagged completion. The reader caps the encoded literal at 8 MiB and the MIME header at 4 KiB. After verifying identity and tagged OK, it accepts a single transfer-encoding field or defaults to 7bit when a complete MIME header omits it. The reader checks 7bit and 8bit line framing and returns the exact bytes. It returns NUL-free binary BODY literals unchanged and decodes base64 and quoted-printable in bounded buffers. Quoted-printable accepts uppercase escapes, CRLF hard and soft breaks, and bounded transport padding. Unknown and malformed encodings fail closed. Peak spool use is 16 MiB per request across both files. Every mode-0600 file is unlinked before bytes are written. The fixture mounts a 32 MiB temporary filesystem in Roundcube. Failure discards the spool before HTTP can emit attachment headers or bytes. [MIME transfer encoding](https://www.rfc-editor.org/rfc/rfc2045.html#section-6) · [IMAP literal framing](https://www.rfc-editor.org/rfc/rfc3501.html#section-4.3.1)

The fixture downloaded 524,288 decoded bytes from 717,450 encoded bytes in one FETCH per request. Exact-part MIME metadata declaring 7bit kept `ABCD` unchanged even though it also forms valid base64. Duplicate encoding declarations, a folded fake field, a wrong or missing MIME section, and unsupported encoding returned 409 without attachment bytes. A UIDVALIDITY change before tagged completion, wrong UID, wrong body section, wrong Message-ID, tagged NO and truncation also returned 409. Oversized MIME and attachment declarations closed before the peer sent a literal. A repeat download returned the same SHA-256.

The staged plugin proof also checks implicit 7bit, 8bit, NUL-free binary and quoted-printable byte for byte. It rejects malformed and truncated quoted-printable, invalid 8bit lines, NUL in a standard BODY literal, and a literal8 response for a BODY request. NUL-bearing data can be returned after base64 or quoted-printable decoding. Raw NUL-bearing BODY literals fall outside the authenticated IMAP4rev1 framing. Negotiated BINARY FETCH is a separate protocol path. [IMAP BINARY extension](https://www.rfc-editor.org/rfc/rfc3516.html#section-4.3)

### Staged Roundcube plugin

Run `bash scripts/infra/mail/roundcube-original-package/stage.sh NEW_ABSOLUTE_DIRECTORY`. The command creates a plugin tree and an inactive config example in a new directory. It refuses an existing destination. The package loads its verifier, mailbox policy and reader from adjacent files and takes no fixture mounts or switches. The example requires the exact HTTPS audience and local base path, API public key, implicit-TLS Jobs account and endpoint, and a real, writable mode-0700 spool directory owned by Roundcube's PHP user. The staged plugin reads the public key only. It rejects unsupported modes and actions, and never falls back to the system temp directory for an attachment. Attachments use the verified numeric section as the download name.

Use `QS_ROUNDCUBE_FIXTURE_PACKAGE=1 QS_ROUNDCUBE_FIXTURE_SPOOL=1 bash scripts/infra/mail/verify-roundcube-http.sh --joined-https` to install that exact staged tree into a pinned disposable Roundcube. The test supplies synthetic config and keys, a 32 MiB tmpfs, API-issued signed URLs, and verified browser-facing and mailbox TLS. Repeat with `QS_ROUNDCUBE_FIXTURE_PACKAGE` set to `no-key`, `wrong-key`, `host`, `audience`, `spool` or `mode` for individual fail-closed controls. These controls reject the signed click before IMAP. [Stage command](../../scripts/infra/mail/roundcube-original-package/stage.sh) · [Config example](../../scripts/infra/mail/roundcube-original-package/quantself-original.inc.php.example)

Atlas still needs a signed upstream release with the reviewed plugin and only `public_html/` exposed. Set PHP `display_errors=Off` and verify the private spool quota and PBS exclusion before activation. Raw NUL-bearing attachment transport, real browser/session behavior, provider framing and encoding, alternate actions and inline resources, and release and backup checks remain outside the staging proof. The Keep observer's systemd staging command installs the observer. [Candidate and gate](#candidate-and-gate)

### Native security-release upgrade rehearsal

Put `pubkey.asc` from Roundcube's download page and the complete `roundcubemail-1.7.5-complete.tar.gz` and `roundcubemail-1.7.6-complete.tar.gz` tarballs with their `.asc` files in a disposable input directory. With the joined fixture images present, run:

```sh
QS_ROUNDCUBE_FIXTURE_PACKAGE=1 QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS=/absolute/path/to/inputs \
  bash scripts/infra/mail/verify-roundcube-http.sh --joined-https
```

The runner checks both SHA-256 pins and detached signatures under the pinned Roundcube Developers key, stages the reviewed plugin in separate read-only native release trees, and serves each `public_html/`. A short-lived helper uses SQLite's WAL locking to clone the active runtime consistently. The candidate mounts only the clone, runs its upstream schema command, and verifies SQLite with `PRAGMA quick_check`. A separate private TLS listener runs the signed handoff and attachment smoke tests before activation. A wrong-key candidate fails before IMAP while the prior containers continue serving. The historical 1.7.5 release is for isolated rehearsal only. [1.7.5 release](https://github.com/roundcube/roundcubemail/releases/tag/1.7.5) · [1.7.6 release](https://github.com/roundcube/roundcubemail/releases/tag/1.7.6) · [Signing key](https://roundcube.net/download/) · [Upstream upgrade guide](https://github.com/roundcube/roundcubemail/wiki/Upgrade)

An update job can run verified staging and candidate qualification using an eligible newer stable 1.7 patch with reviewed version, digest and signer pins. The qualification clone is old by cutover time. In the fixture, it missed a later stock login, the authenticated session and an identity display-name setting. Its private listener sent that browser back to login.

The same native proof rehearses a bounded cutover. The main route replies with 503 and `Retry-After` to GET and POST, then both workers must drain with a clean exit. The runner takes a final SQLite snapshot, migrates and checks it, and verifies the captured session and exact attachment privately before switching the route. The runner budgets 25 seconds for cutover and verification, with a separate 20-second recovery budget.

Pre-promotion recovery can resume the prior runtime and verify the late writes with the same cookie. Once a candidate route switch has been attempted, the fixture has no compatibility proof for writes the candidate may have accepted. Recovery re-freezes the route, stops the candidate and retains its SQLite state. The incompatible case models a candidate-only migration with a table and trigger. An authenticated browser saves a stock identity change after promotion with one HTTPS GET and one POST and no IMAP. After the freeze, the stopped candidate still has the changed identity, the new table's record and the browser session. The prior volume still has the pre-promotion values and lacks the new table. The rehearsal verifies this state before removing its disposable environment.

### Release metadata selection

Use the [Roundcube security index](https://roundcube.net/news/security/) to obtain the official bulletin HTML and the [official repository releases API](https://docs.github.com/en/rest/releases/releases#list-releases) to obtain the release records. The security bulletin links the exact tags for its maintained branches. GitHub's repository-wide latest endpoint uses release commit dates and includes other branches. Save release pages as one JSON array. For example:

```sh
gh api --paginate --slurp 'repos/roundcube/roundcubemail/releases?per_page=100' | jq add > releases.json
curl --fail --location --output bulletin.html \
  https://roundcube.net/news/2026/11/09/security-updates-1.6.21-and-1.7.6
python3 scripts/infra/mail/select-roundcube-security-release.py \
  --installed 1.7.5 --releases releases.json --bulletin bulletin.html > plan.json
```

The offline selector uses the numerically highest newer stable 1.7 tag linked from the supplied security notices. It requires one published release for that exact tag, the official complete tarball and detached signature URLs, and both SHA-256 digests. Missing or inconsistent metadata for the selected tag fails closed. A null candidate means the supplied notices contain no newer eligible patch.

The readiness checker passes the selected plan to the native proof. The 1.7.5 to 1.7.6 fixture checks it against its independently pinned archive digest, checks the signature file digest, and verifies the archive under the pinned Roundcube signing key before extraction. Metadata capture and selection remain separate from signature trust and activation. Live discovery and scheduling remain open.

### One-shot patch readiness

An eventual scheduled check can capture fresh official metadata and invoke the offline handoff once the asset files are available. With the pinned disposable inputs:

```sh
python3 scripts/infra/mail/check-roundcube-patch-readiness.py \
  --installed 1.7.5 --releases releases.json --bulletin bulletin.html \
  --assets /absolute/path/to/inputs
```

The command emits one JSON result on stdout. `no_candidate` means the supplied notices have no eligible newer patch and exits before Docker or asset checks. `fixture_qualified` records the exact asset plan and SHA-256 hashes of the four mounted plugin files after the private TLS smoke and the prior route check succeed. Diagnostics go to stderr. Metadata, verification, or smoke failure exits nonzero without a qualification result. An eventual job should consume the current successful invocation's result.

The handoff stops before maintenance mode or route switching and removes the disposable environment. It defaults to the pinned 1.7.5 to 1.7.6 pair. For another stable 1.7 security update, pass `--reviewed-release reviewed-release.json`. The JSON contains `prior` and `candidate` objects, each with `version`, `archive_sha256` for the complete archive and `signature_sha256` for its detached signature. Supply this separately reviewed input alongside official discovery. The selected pair and candidate asset URLs and hashes must match it. Staging checks both releases against the reviewed hashes and the independently pinned signing key fingerprints.

For a later disposable cutover, save the `fixture_qualified` JSON and rerun the checker with `--revalidate-receipt readiness.json`, the current installed version, fresh official captures and the same reviewed release input if supplied. The fresh selection must agree on both versions, both asset URLs and both digests. A newer candidate, a changed review or an already upgraded installation invalidates the receipt. Older receipts without reviewed release pins can revalidate with the built-in pair. Before any container starts, the fixture reverifies the archives and signatures and compares the staged PHP hashes with the receipt. A bare saved plan cannot enter the cutover path.

The later invocation repeats private TLS qualification and takes its own final SQLite snapshot after the freeze. It emits `fixture_cutover_revalidated` with `rollback: held_candidate_state_retained` after proving cutover and a held incompatible rollback. The receipt carries asset and plugin identity. Freshness of the supplied official captures depends on the caller's acquisition.

For a check with fresh discovery, replace `--releases` and `--bulletin` with `--fetch-official`. It reads the current official security index and every indexed bulletin, then requests only the selected release tag from GitHub. The second index read must list the same bulletins. The current ten-notice index takes 13 requests with a candidate and 12 without one, with at most four bulletin requests running at once. HTTPS requests reject redirects, validate the expected URL and content type, and have a seven-second request limit within a 25-second acquisition budget. Missing, incomplete, paginated, or changed index evidence fails the check before any qualification result. The acquisition step fetches metadata only. Staging still verifies the supplied artifacts, and cutover remains a separate invocation. [Security index](https://roundcube.net/news/security/) · [Release by tag API](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)

Add `--fetch-assets` to download the selected candidate archive and detached signature into disposable staging inputs. Supply the prior release, its signature, and the separately provisioned `pubkey.asc` in `--assets`. The checker validates the reviewed fixture plan before requesting assets and leaves that input directory intact. Each transfer permits a direct response or one HTTPS redirect to the Roundcube repository's path on GitHub's release-asset host. The two transfers run concurrently with a 30-second request limit, a 45-second shared deadline, and size limits of 32 MiB for the archive and 64 KiB for the signature. The pinned release took four asset requests. Staging still checks both digests and the detached signature under its independently pinned key fingerprints before extracting the candidate. Omit `--fetch-assets` to use saved assets. [Official assets](https://github.com/roundcube/roundcubemail/releases/tag/1.7.6) · [Signature verification](https://roundcube.net/download/)

#### Unattended disposable qualification

Provision `qualification.json` in a trusted local directory, with paths relative to that file or absolute paths.

```json
{
  "installed_manifest": "installed.json",
  "assets": "release-inputs",
  "reviewed_release": "reviewed-release.json"
}
```

The operator provisions `installed.json` from the installed release record. Its only field is `version`, for example `{"version":"1.7.5"}`. The job, manifest and review must be regular files owned by the runner or root and writable only by their owner. Supply the installed archive, signature and independent public key in `release-inputs`. Omit `reviewed_release` to bootstrap discovery before a pair is reviewed.

```sh
python3 scripts/infra/mail/check-roundcube-patch-readiness.py --qualification-config /absolute/path/to/qualification.json
```

Each run fetches fresh official metadata once and emits one JSON object. `no_candidate` and `review_required` exit 0 without downloading assets or starting Docker. `review_required` includes the selected plan when the installed and candidate versions lack a current explicit review. If an approved tag's asset identity changes, the job emits `failed`, exits 1 and logs the diagnostic to stderr. Acquisition, verification and smoke failures also emit `failed`. On success, `fixture_qualified` includes the qualifying plan, reviewed pins and plugin file hashes. The job stops after disposable qualification. The checker can be invoked manually until a runner and cadence are approved. Cutover still uses the separate receipt revalidation flow.

### Packaged plaintext display

Run `QS_ROUNDCUBE_FIXTURE_PACKAGE=1 QS_ROUNDCUBE_FIXTURE_DISPLAY=1 bash scripts/infra/mail/verify-roundcube-http.sh --joined-https`. The guard renders part 1 as escaped text after fetching the exact UID, Message-ID projection, body and part MIME header together. It requires a single `text/plain` type with UTF-8 or US-ASCII charset and an absent or inline disposition. Limits are 256 KiB encoded and 64 KiB decoded. The page contains the verified text and signed attachment links. The guard omits native sender/subject headers and MIME objects and never dispatches HTML body or inline resources.

The staged proof compared 5,099 multilingual UTF-8 bytes after HTML escaping. Script and image markup stayed inert, and the response used a restrictive Content Security Policy. Each case used one combined UID FETCH, with no separate native header, structure or body fetch. HTML, ambiguous MIME type, attachment disposition, charset mismatch, invalid UTF-8, wrong part or identity, epoch change, tagged NO and both size limits failed closed.

With source issuance enabled, a verified `text/html` body in part 1 shows **View source** and any verified attachment links. The same combined FETCH must pass the display charset, disposition, encoding, size, identity and tagged completion checks. The preview emits no message body and makes no raw-source FETCH. To verify the fallback and exact bytes after clicking the signed links, set `QS_ROUNDCUBE_FIXTURE_SOURCE=1` alongside the display proof flags.

### Packaged View source

Run `QS_ROUNDCUBE_FIXTURE_PACKAGE=1 QS_ROUNDCUBE_FIXTURE_SOURCE=1 bash scripts/infra/mail/verify-roundcube-http.sh --joined-https`. The staged plugin requests the exact UID, Message-ID projection and `BODY[]` in one FETCH over verified IMAP TLS. It reads up to 8 MiB into one anonymous private spool in 64 KiB chunks. After successful tagged completion and the projection check, the raw header must end within the first 64 KiB and contain exactly one matching Message-ID. The plugin returns the unchanged bytes as plaintext with `nosniff` only after both checks.

The synthetic original returned 718,447 identical bytes. A stale selected epoch stopped before FETCH. Mid-fetch epoch change, mismatched UID, wrong section, mismatched projection, wrong, missing or duplicate raw Message-ID, oversized header or literal, truncation and tagged NO returned 409 without source bytes. The oversized literal was refused before the peer sent it.

With `QUANTSELF_JOBS_ROUNDCUBE_SOURCE_ENABLED=1`, the existing Owner Open original route adds the 86-byte detached `_source` signature to the Show handoff after the same fresh observation. The API keeps the signing key. Roundcube reconstructs the source reference from the verified parent's exact identity bytes and timestamps and validates it before rendering **View source**. The packaged proof follows the actual API 303, stock login and rendered link. Show-only links still render without a source action. Roundcube rejects duplicate fields and signatures for another action, identity or expiry before IMAP.

In the fixture, `_source` added 95 bytes to the initial request target, including its field name. The Show request target was 593 bytes with both handoffs. It used five IMAP commands excluding logout, including one FETCH. **View source** used a 319-byte request target, one HTTP GET and one UID FETCH. The signer and packaged verifier limit a combined request target to 4,096 bytes. API issuance still uses one EXAMINE, one UID SEARCH and one UID FETCH.

### Atlas config-only PBS layout

The November 16 evidence records `atlas-apps-3358-nightly` on Atlas for VM 3358 alone, in snapshot mode at 01:30 Halifax. Its verified archive was `backup:backup/vm/3358/2026-11-16T15:54:28Z`. The job copies included VM disks. The Roundcube backup boundary therefore depends on where the guest writes data. [Atlas job evidence](https://github.com/devdogfish/quantself/issues/358#issuecomment-6921808559) · [Proxmox VM snapshot backups](https://github.com/proxmox/pve-docs/blob/master/vzdump.adoc#backup-modes)

| Roundcube data | Proposed guest location |
| --- | --- |
| Reviewed site configuration, public verification and trust material, and staged plugin | `/opt/quantself-roundcube/` on the backed disk |
| PHP or Roundcube sessions, runtime database and journals, message temporary files, private spool, and message-bearing logs | `/run/quantself-roundcube/` on tmpfs, including temporary upload directories and container mounts |
| Runtime secret files, including session encryption material and any service credentials | Private runtime mount, provisioned separately from the reviewed tree. Use a dedicated VM disk with `backup=0` if persistence is required. |

Before deployment, map the effective PHP, Roundcube, container and proxy write paths to their actual mounts. Keep message caches disabled. Ensure persistent proxy or journal logs omit signed request URLs and message data. Verify that swap, hibernation and dumps cannot persist runtime state on a backed disk. The Ed25519 private signing key stays on the API side. [Proxmox disk backup setting](https://github.com/proxmox/pve-docs/blob/master/generated/qm.1-synopsis.adoc)

Run the offline model in a local Docker context with the pinned image already present.

```sh
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --mount "type=bind,src=$PWD/scripts,dst=/scripts,readonly" \
  docker.io/library/python@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 \
  python -IB /scripts/infra/mail/roundcube-original-package/prove-config-backup.py
```

The proof stages the actual plugin and a synthetic site config, inventories them independently, archives the complete modeled backed disk with the existing GNU tar helper, then restores and checks the inventory. The restored tree must contain the reviewed config and four plugin files. All six canaries must be absent, and the runtime mountpoint must be empty. Negative controls move runtime data onto the backed disk, populate the backed mountpoint, alter the plugin, and remove the config. These fail the restore audit. [Proof](../../scripts/infra/mail/roundcube-original-package/prove-config-backup.py) · [Archive helper](../../scripts/integration/backup-metadata/archive-tree.sh) · [Inventory helper](../../scripts/infra/keep-storage/backup_inventory.py)

#### Atlas pre-boot PBS inspection

The signed-bundle rehearsal restored 3,700 browser-tree entries and both systemd units from the complete modeled backed disk in 7.676 s. It verified all three backed mountpoints and rejected leaked SQLite data, either credential form, a populated mountpoint, a changed unit and missing browser config. Use the following inspection for a fresh authorized VM 3358 restore. [Signed-bundle backup evidence](https://github.com/devdogfish/quantself/issues/359#issuecomment-6967771567)

Before the snapshot, independently record the reviewed browser tree and both installed unit files from the frozen, approved filesystem. Use Bash on Linux as the recovery operator. Set `frozen_root` to the pre-backup reference mount and `evidence` to the absolute path of a new private directory outside the source and restore mounts. Run from the reviewed checkout and keep the resulting files with the encrypted recovery evidence.

```bash
set -euo pipefail
umask 077
: "${frozen_root:?Set the frozen reference mount}" "${evidence:?Set the private evidence directory}"
[[ "$frozen_root" = /* && "$evidence" = /* ]]
inventory="$PWD/scripts/infra/keep-storage/backup_inventory.py"
browser=/opt/quantself-roundcube/browser
service=quantself-roundcube-browser.service
credential_mount=$(systemd-escape --path --suffix=mount /run/quantself-roundcube-inputs)
python3 -B "$inventory" capture "$frozen_root$browser" "$evidence/browser.inventory.json"
(
  cd "$frozen_root/etc/systemd/system"
  for unit in "$service" "$credential_mount"; do
    [[ -f "$unit" && ! -L "$unit" ]] || exit 1
  done
  set -o noclobber
  sha256sum -- "$service" "$credential_mount" > "$evidence/browser-units.sha256"
)
```

Use an isolated synthetic browser activation and its own backup to prove all nine exclusions. Independently confirm each distinct printable marker was present at the effective runtime location at snapshot time. Keep one marker per line in `evidence/browser-canaries.txt`. The filenames below are fixture examples. Never replace a live database, log, spool file or credential with canary data. For the WAL, record synthetic bytes present before checkpoint. For the credential input, record a printable sequence from the fixture ciphertext actually written. Record only synthetic key bytes in this evidence.

| Runtime path | Canary |
| --- | --- |
| `run/quantself-roundcube/roundcube.sqlite` | SQLite session |
| `run/quantself-roundcube/roundcube.sqlite-wal` | SQLite WAL |
| `run/quantself-roundcube/session/fixture` | PHP session |
| `run/quantself-roundcube/tmp/message.eml` | Temporary message |
| `run/quantself-roundcube/spool/part.bin` | MIME spool |
| `run/quantself-roundcube/logs/errors.log` | Roundcube log |
| `run/quantself-roundcube/logs/php.log` | PHP log |
| `run/quantself-roundcube-inputs/des-key.cred` | Encrypted credential |
| `run/credentials/quantself-roundcube-browser.service/des-key` | Injected synthetic key |

Keep the restored VM stopped and disconnected. Check the restored VM config and PBS disk list against the approved source. Attach each restored block device read-only and require `blockdev --getro "$device"` to return `1` before mounting, including for filesystems that could replay a journal. Follow the recovery mount options for each filesystem. Mount each complete filesystem individually read-only, without guest runtime overlays.

This procedure expects the reviewed browser tree, systemd units and runtime mountpoint directories on the restored root filesystem. If the disk inventory places any of these paths on a separate filesystem, the inspection needs an explicit mapping for those paths before acceptance. List **every included restored filesystem** with its corresponding block device in inventory order, starting with the restored root. Set `inspection_kind=synthetic` for the nine-canary snapshot or `inspection_kind=installed` for the installed archive. Use independent pre-backup evidence for the selected snapshot. Any failure stops acceptance before boot. [Linux mount manual](https://github.com/util-linux/util-linux/blob/master/sys-utils/mount.8.adoc)

```bash
set -euo pipefail
: "${restored_root:?Set the read-only restored root}" "${restored_root_device:?Set its reviewed block device}"
: "${evidence:?Set the private evidence directory}"
: "${inspection_kind:?Set synthetic or installed}"
: "${expected_filesystems:?Set the reviewed filesystem count}"
[[ "$evidence" = /* ]]
backed_filesystems=("$restored_root") # Append each additional included filesystem mount.
backed_devices=("$restored_root_device") # Append the corresponding reviewed block devices.
[[ "$expected_filesystems" =~ ^[1-9][0-9]*$ && "${#backed_filesystems[@]}" = "$expected_filesystems" ]]
[[ "${#backed_devices[@]}" = "$expected_filesystems" ]]
inventory="$PWD/scripts/infra/keep-storage/backup_inventory.py"
browser=/opt/quantself-roundcube/browser
units=/etc/systemd/system
patterns="$evidence/browser-canaries.txt"
service=quantself-roundcube-browser.service
credential_mount=$(systemd-escape --path --suffix=mount /run/quantself-roundcube-inputs)
export LC_ALL=C

case "$inspection_kind" in
  synthetic)
    awk 'length($0)<16 || /[^ -~]/ || seen[$0]++ { bad=1 } END { exit (bad || NR!=9) }' "$patterns"
    ;;
  installed) ;;
  *) exit 1 ;;
esac
declare -A seen_devices=()
for index in "${!backed_filesystems[@]}"; do
  disk=${backed_filesystems[index]}
  source=${backed_devices[index]}
  [[ "$disk" = /* && "$disk" != / && "$(realpath -e -- "$disk")" = "$disk" ]]
  [[ "$source" = /dev/* && -b "$source" && "$(blockdev --getro "$source")" = 1 ]]
  source_id=$(lsblk -dnro MAJ:MIN -- "$source")
  mounts=$(findmnt -R -n -r -o MAJ:MIN,FSROOT,VFS-OPTIONS,FS-OPTIONS --mountpoint "$disk")
  [[ -n "$mounts" && "$mounts" != *$'\n'* ]]
  read -r device filesystem_root mount_options filesystem_options <<< "$mounts"
  [[ "$device" =~ ^[0-9]+:[0-9]+$ && "$device" = "$source_id" && "$filesystem_root" = / ]]
  [[ ",$mount_options," = *,ro,* && ",$filesystem_options," = *,ro,* ]]
  [[ -z ${seen_devices["$device"]+found} ]]
  seen_devices["$device"]=1
done

for rel in "$browser" "$units"; do
  [[ "$(realpath -e -- "$restored_root$rel")" = "$restored_root$rel" ]]
done
for rel in apache.conf site.json installed.json original.pub imap-ca.pem \
  prepare-runtime.sh check-credential-mount.sh release/config/config.inc.php \
  release/public_html/index.php release/plugins/quantself_original/{quantself_original,verify,mailbox,bounded_imap}.php; do
  required="$restored_root$browser/$rel"
  [[ -f "$required" && "$(realpath -e -- "$required")" = "$required" ]]
done
python3 -B "$inventory" verify "$restored_root$browser" "$evidence/browser.inventory.json"
(
  cd "$restored_root$units"
  for unit in "$service" "$credential_mount"; do
    [[ -f "$unit" && ! -L "$unit" ]] || exit 1
  done
  sha256sum -- "$service" "$credential_mount" | cmp -s -- "$evidence/browser-units.sha256" -
)

for rel in /run/quantself-roundcube /run/quantself-roundcube-inputs \
  /run/credentials/quantself-roundcube-browser.service; do
  point="$restored_root$rel"
  [[ "$(realpath -m -- "$point")" = "$point" && ! -L "$point" ]]
  if [[ -e "$point" ]]; then
    [[ -d "$point" ]]
    child=$(find -P "$point" -mindepth 1 -print -quit)
    [[ -z "$child" ]]
  fi
done

if [[ "$inspection_kind" = synthetic ]]; then
  for disk in "${backed_filesystems[@]}"; do
    # Only grep status 1 means no marker. Any match or read error fails the audit.
    find -P "$disk" -xdev -type f -exec sh -c '
      marker_file=$1; shift
      if grep -aFq -f "$marker_file" -- "$@"; then exit 1; else test "$?" -eq 1; fi
    ' sh "$patterns" {} +
  done
  printf 'PASS browser inventory, 2 units, 3 mountpoints, 9 canaries across %s filesystems\n' \
    "${#backed_filesystems[@]}"
else
  printf 'PASS installed browser inventory, 2 units and 3 mountpoints\n'
fi
```

Record the snapshot ID, filesystem count, inventory entry count and pass/fail only. Keep the evidence and restore private. The synthetic canary result qualifies the tested layout. Installed PBS acceptance still requires the actual disconnected restore, review of the included disks and confirmation of the installed runtime mounts.

### Atlas browser bundle

Stage the browser separately from the Keep observer. The native bundle targets Debian 13 with Apache prefork, PHP 8.4 Apache and CLI modules, and Roundcube's PHP dependencies including SQLite and Sodium. Install `libnss-systemd` and confirm `passwd` and `group` in `/etc/nsswitch.conf` both include `systemd`. Apache resolves the service's dynamic account through NSS. The bundle pins the signed complete upstream 1.7.6 release and stages the existing guard. Review the current upstream security release before installation.

`site.json` supplies the exact approved Serve origin, all reviewed sibling service hostnames including the VM's regular hostname, an unused high loopback port, IMAP DNS name and canonical Jobs mailbox. The browser hostname must be distinct from every listed sibling. Browser cookies share a hostname across ports. The following values are illustrative.

```json
{
  "version": "1.7.6",
  "origin": "https://atlas-browser.fixture.ts.net:18445",
  "sibling_hosts": ["atlas-apps.fixture.ts.net"],
  "loopback_port": 18080,
  "imap_host": "imap-fixture.example.test",
  "mailbox": "jobs@example.test"
}
```

With the complete archive, detached signature and upstream `pubkey.asc` already staged, run:

```sh
python3 -B scripts/infra/mail/roundcube-browser-deploy/stage.py "$new_absolute_stage" \
  --site "$site_json" --assets "$signed_release_assets" \
  --verify-key "$api_ed25519_public_pem" --imap-ca "$reviewed_imap_ca_pem"
python3 -B scripts/infra/mail/roundcube-browser-deploy/verify-atlas.py "$signed_release_assets"
```

The renderer verifies both pinned digests and the upstream signer. It emits the browser service, its credential mount unit, and a complete tree for `/opt/quantself-roundcube/browser/`. The public key must be Ed25519 SubjectPublicKeyInfo PEM. The IMAP CA file must contain certificates only. Keep the browser tree root-owned and read-only to the service. The service has no boot enablement section.

For later installation, start only the dedicated credential mount first. It mounts root-only, non-swapping tmpfs at `/run/quantself-roundcube-inputs/`. The Owner stages an encrypted systemd credential named `des-key` at `des-key.cred` inside that mount. Its decrypted payload must be 32 bytes. The unit uses `LoadCredentialEncrypted` and refuses to run on a persistent or swappable source mount. Keep the ciphertext out of the backed tree too. Provision again after unmount or reboot. The Owner supplies the mailbox password through the later browser login. [systemd credentials](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#LoadCredential=ID:PATH)

Apache listens only on IPv4 loopback and serves only upstream `public_html/`. The local proxy must present the exact Host authority including any nondefault port and a verified HTTPS scheme. Apache rejects the Funnel marker. Roundcube binds signed references to the hostname and uses dedicated host-only Secure cookies. Verify the installed Tailscale version supports the approved dedicated service hostname, keep Funnel off and scope the route to the Owner. [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) · [Proxy implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)

Runtime SQLite, sessions, temporary files, spool and Roundcube logs live under `/run/quantself-roundcube/`. The unit requires tmpfs and disallows swapping its memory. Apache access logging is absent and service output is discarded. Mail caches and outbound send are disabled. Verify that the actual ingress and runtime credential source stay outside persistent request logs, backed swap and the included disks.

The offline proof used the staged signed assets, the pinned Roundcube Apache image and Debian 13 systemd 257.13. Staging took 0.83 s. Runtime checks took 1.05 s. The relay preserved the exact TLS Host and port, served stock login with a Secure, HttpOnly, SameSite=Lax cookie, and accepted a signed synthetic handoff. It rejected a forged reference, installer traffic, wrong authority, direct HTTP and the Funnel marker. The fixture also refused persistent and swappable credential mounts and left the backed bundle byte-identical. The full proof took 3.44 s.

`systemd-analyze verify` checked both units. The browser ran separately in an unprivileged disposable container with a synthetic credential directory. The native VM proof below covered the mount and activation.

The local Docker Linux 6.12.76 rehearsal reached the kernel with an unprivileged user namespace. An ordinary tmpfs mounted successfully. The same mount with `noswap` exited 32 with `Turning off swap in unprivileged tmpfs mounts unsupported`. Linux requires `CAP_SYS_ADMIN` in its initial user namespace for this option. [Linux 6.12 tmpfs implementation](https://github.com/torvalds/linux/blob/v6.12/mm/shmem.c#L4053-L4059)

The bundle at `b191d5cc` passed a native activation proof in a disposable Debian 13 arm64 guest. The staging inputs are byte-identical to merged #516. QEMU 10.0.13 used software emulation and `-nic none` in a Docker container with its default capabilities. The guest booted Linux `6.12.117+deb13-arm64` and systemd `257.13-1~deb13u1` from a scratch ext4 disk. The minimal guest's first browser process exited without `libnss-systemd`. The passing run used that package at `257.13-1~deb13u1`, Apache 2.4.71 and PHP 8.4.27. [Merged bundle #516](https://github.com/devdogfish/quantself/pull/516)

Systemd started the staged credential mount. The mount guard confirmed root-owned mode 0700 tmpfs with `noswap`. The guest encrypted a synthetic 32-byte key under its own temporary host key and started the staged service. The proof matched the injected bytes inside the unprivileged worker's mount namespace and checked `MemorySwapMax=0` and tmpfs runtime state. A loopback HTTPS request verified the stock login cookie and signed guard. Roundcube authenticated to the synthetic TLS IMAP peer with one `LOGIN` at 44.81 s after guest kernel boot. Stopping the service removed its listener, runtime database and credential view. Stopping the mount removed the ciphertext. All checks passed at 45.88 s after guest kernel boot.

Later authorized installation takes the reviewed staged tree and the unit, starts only the loopback backend, and qualifies the intended Serve origin and scoping separately. Before enabling link issuance, prove the Owner Mac and iPhone, denial for other peers and LAN/WAN, the real Purelymail account path, and a disconnected config-only PBS restore. Stop the browser service and remove only its approved ingress mapping on rollback. Staged upgrade scheduling and promotion stay separate.

## Failed login and retry

A valid signed login that reaches Roundcube's stock failure handler carries its already-verified query in request-local state. After core clears the failed session, the fixture checks expiry again, regenerates the temporary session ID with deletion of the previous session, and binds the exact query to the new stock 401 form. It holds no submitted password across requests. A failed or invalid POST without a validated pending reference cannot create retry state. [Core login failure](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/public_html/index.php#L154-L175) · [Session regeneration](https://github.com/roundcube/roundcubemail/blob/1a6635100bb18c7184441f9230a8379e6e7b3e39/program/lib/Roundcube/rcube_session.php#L296-L312)

With pinned images already cached, run each mode with `bash scripts/infra/mail/verify-roundcube-http.sh`.

| Mode | Observed HTTP behavior |
| --- | --- |
| `QS_ROUNDCUBE_FIXTURE_LOGIN_RETRY=1` | Wrong password returns stock 401 with the exact URL and a new temporary cookie. The stale cookie gets 401. Correct credentials with the current cookie return 302 to the exact signed source URL, then GET returns 200 raw source. A reference that expires after the failed login returns 409 on retry. Run took 18.47 s including real expiry wait. |
| `QS_ROUNDCUBE_FIXTURE_LOGIN_RETRY=controls` | Changing the pending action to a different valid reference or changing the mailbox returns 409. Ordinary unsigned login retains stock 401 and successful retry 302. Run took 8.91 s. |

The rejected retries issued no redirect or IMAP command and returned no protected bytes. An initial combined run reached core login throttling. The two fixture modes use fresh disposable instances and retain stock throttling. Production qualification still needs private TLS, proxy cookie and token handling, the deployed session store, and the actual provider's authentication and fetch behavior.

### Packaged session concurrency

Run `QS_ROUNDCUBE_FIXTURE_PACKAGE=1 QS_ROUNDCUBE_FIXTURE_SESSION_CONCURRENCY=1 bash scripts/infra/mail/verify-roundcube-http.sh --joined-https`. This uses the pinned image's stock database sessions on disposable SQLite. The synthetic TLS peer holds the first login after core retires its temporary session. Replaying that cookie or substituting another browser's handoff failed before IMAP. Two independent browser sessions resumed their exact URLs and each read the approved view in one FETCH. Retired and mixed session cookies exposed no protected links or bytes.

On an empty database, stock Roundcube initially attempted two inserts for the same mailbox user. One returned 401 after the unique constraint rejected it. With automatic user creation enabled, login adds one local user lookup. If the mailbox user is absent, the package waits up to five seconds for a provisioning lock in the existing private spool. The fixture checks that cold provisioning waits and that the second provisioned browser finishes while the first is still held. The lock qualifies workers sharing the same spool directory on one instance.

The configured account must already match Roundcube’s `login_lc` normalization. With the stock lowercase default, a mixed-case account is rejected before IMAP even if a legacy user row has that spelling. Run the mounted TLS proof with `QS_ROUNDCUBE_FIXTURE_PACKAGE=mixed-case-account` to exercise that row.

## Qualification and rollback

1. In a disposable setup, exercise a signed-out click and resume after login, an active Jobs session, a wrong/pre-existing mailbox session, an invalid or expired reference, and folder names with hierarchy, spaces, ampersands and international characters. Verify exact original and expected Seen behavior.
2. Test identical folder/UID across accounts, UID reuse after recreation, invalidation between selection and fetch, moves, expunges, compound UID overrides, duplicate or missing Message-ID, and absent or forged recipient evidence. Repeat checks for source, attachments and inline parts, including a change between view and part fetch. Expect no exposure on failure.
3. In an authorized disposable mail window, test real direct and Bcc, bare address, unregistered code and a caller-forged trace header over raw SMTP that demonstrably reaches the Purelymail boundary. Compare raw trace ordering and message linkage to known envelope recipients. Keep recipient-based automation gated if the forged trace is indistinguishable or cannot reach the provider.
4. Qualify patch, private access and backup recovery before enabling links. On failure, disable link issuance in Quantself and Bot HQ, remove only the Roundcube Serve mapping and grant, stop its backend, and revoke the disposable credential. Verify existing VM 3358 services and the backup job stay healthy. Use Purelymail webmail for access during rollback.

Live steps require the named approvals applicable under [#217](https://github.com/devdogfish/quantself/issues/217) and the [infrastructure session workflow](../agents/infrastructure-sessions.md), including explicit approval before firewall or Tailscale changes. The Owner handles secrets.
