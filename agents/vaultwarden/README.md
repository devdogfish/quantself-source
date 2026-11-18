# Agent Vaultwarden unlock service

The unlock service supplies the [startup-key contract](../README.md#vaultwarden-integration), the private browser and the [status-only website sign-in tool](../../docs/agents/hermes-setup.md#website-sign-in-service-376) for [#376](https://github.com/devdogfish/quantself/issues/376).

The [server runbook](server/README.md) covers VM 2549 on Keep and the backup gate before credential handoff.

## Prepare the Agent's vault

The Owner creates a private startup folder in the Agent's Vaultwarden account. Use one Secure Note per allowlisted startup key, named exactly as in the Agent installer README, with the value alone in the note body. Use the folder ID as the installer argument. Keep website and mailbox credentials outside this folder.

The service uses the private Bitwarden CLI profile at `/var/lib/quantself-vaultwarden/bw`. It reads the folder in one local CLI call after unlock and rejects duplicates, missing names, organization-owned notes and malformed values. To apply a startup-key rotation, the Owner runs `sudo /usr/local/libexec/quantself-vaultwarden-keys --sync` before restarting the Agent. Socket activation reads cached startup keys even before the network is ready. Sync and new website sign-ins require a live Vaultwarden connection. The Hermes UID can access the allowlisted startup keys by design. Website credentials stay within the service.

Use the Owner's organization for shared logins. Group items in a collection only when they have the same intended recipients. To delegate sharing, give the sending Agent the Vaultwarden Manager role with manage access to that collection. The sender can move a personal login into the collection and give the recipient view access. Remove the recipient's collection grant to block fresh logins at the next service sync. Rotate the website credential and revoke website sessions when access must end immediately. [Vaultwarden role enforcement](https://github.com/dani-garcia/vaultwarden/blob/1.37.5/src/auth.rs#L911-L948)

Prepare non-secret per-Agent site recipes using [sites.example.json](sites.example.json). The keys are approved Vaultwarden item UUIDs. Recipes describe same-origin HTTPS login and verification pages, form selectors, challenge selectors and the exact cookies needed for the session. The service checks the live Vaultwarden grant and saved origin before using a recipe. An empty object provisions startup keys alone.

Optional `forms` map names to reviewed native forms. Pin the page URL, exact POST action, field aliases and selectors, submit button, and success marker. The reader lists the names and field aliases. The submit tool accepts only those fields, refuses credential inputs, and verifies the effective form destination before sending one POST. Check the website before retrying if the result is `outcome_unknown`.

A form defaults to `"approval": "owner"`. Set `"approval": "autonomous"` only for actions already within that Agent's approved autonomy. Keep actions reserved for the Owner out of Agent recipes. When the tool returns `approval_required`, the Agent hands back the requested item, form, and field values in Bot HQ. The Owner independently reviews those values and supplies a JSON object with `item_id`, `form`, and `fields` from the Agent host's private admin console.

```sh
sudo /usr/local/libexec/quantself-vaultwarden-keys --approve-site < reviewed-submission.json
```

The service accepts that approval only from root. `approved` grants one attempt for those exact values within five minutes. Lock, relock, a new sign-in, or service restart clears the grant. An ambiguous attempt consumes the grant. The Agent checks the site's state before requesting another approval.

Agents own 2FA for their accounts. Optional `totp` pins a native challenge page, same-origin HTTPS POST action, code field and submit button. With a TOTP seed on the approved Vaultwarden item, the service requests the current code from the Bitwarden CLI only after it reaches the challenge. It verifies the effective destination, submits once in the existing private page, and verifies sign-in before handing off the authenticated session. [Bitwarden CLI](https://bitwarden.com/help/cli/#get)

## Apply only during an approved Agent setup

On the Agent's dedicated Debian host, provide `bw` on the system PATH, `chromium`, `libpsl5t64` and `python3-venv`, and provision the locked `hermes` account. Use the official Bitwarden CLI with the private Vaultwarden HTTPS URL. CLI v2026.10.1 was verified with Vaultwarden 1.37.5. [Bitwarden CLI release](https://github.com/bitwarden/clients/releases/tag/cli-v2026.10.1)

Run `sudo bash agents/vaultwarden/install.sh STARTUP_FOLDER_UUID SITES.json [BUSINESS_MAIL_ITEM_UUID]`. The installer installs the pinned Playwright environment and the service as a separate locked user. It leaves socket activation for the approved credential handoff. Omit the mail item to disable business mail.

The Owner accepts the vault invitation and sets the Agent's vault master password. After the installer runs, use that Agent's private admin console. Set `vault_url` to the approved private HTTPS endpoint and enter the Agent account at the CLI prompts. Quiet mode keeps the session key off stdout. Leave the account signed in so the service can unlock the local cache. [Bitwarden CLI login](https://bitwarden.com/help/cli/#using-email-and-password)

```bash
vault_bw() {
  sudo -u quantself-vaultwarden -H env -u BW_SESSION \
    BITWARDENCLI_APPDATA_DIR=/var/lib/quantself-vaultwarden/bw \
    /usr/local/bin/bw "$@"
}
vault_bw config server "${vault_url:?Set this to the approved Vaultwarden HTTPS endpoint}" &&
  vault_bw login --quiet &&
  vault_bw status --raw |
    python3 -c 'import json, sys; sys.exit(json.load(sys.stdin)["status"] != "locked")' &&
  printf '%s\n' 'Agent vault profile signed in and locked'
```

From the same private console, enter the Agent's vault master password at the hidden systemd prompt. The shell writes the encrypted output only after the prompt and encryption succeed. The service reads the credential from systemd's private mount. [systemd credential encryption](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html#encrypt%20input%7C-%20output%7C-)

```bash
sudo bash -c '
  set +x
  set -euo pipefail
  umask 077
  encrypted=$(systemd-ask-password -n --echo=no "Agent vault master password" |
    systemd-creds encrypt --with-key=host --name=unlock - -)
  test -n "$encrypted"
  printf "%s\n" "$encrypted" |
    install -T -m 0600 /dev/stdin /etc/quantself-vaultwarden/unlock.cred
'
```

After the Owner handoff, enable and start `quantself-vaultwarden.socket`. The Hermes startup and screen adapters consume the keys. The Agent installer registers the sign-in, protected reader and configured form submitter. Authenticated contexts stay in headless Chromium under the service user. Playwright controls Chromium over its private pipe. The Agent's normal screen keeps its own profile. Verify using fake credentials and check elapsed time without displaying key values.

```bash
sudo -u hermes test ! -r /etc/quantself-vaultwarden/unlock.cred &&
  sudo -u hermes test ! -r /var/lib/quantself-vaultwarden/bw &&
  time sudo -u hermes /usr/local/libexec/quantself-vaultwarden-keys \
    ANTHROPIC_API_KEY HONCHO_API_KEY API_SERVER_KEY QUANTSELF_API_KEY BOT_HQ_MCP_TOKEN VNC_PASSWORD \
    >/dev/null
```

Expect exit zero and a startup-key response within 15 seconds on the first request and after idle relock. Repeat the check after the approved synthetic pilot reboot.

If the vault code is missing, unusable or rejected, or the challenge is unsupported, the service closes the attempted login context and returns `sign_in_blocked`. The Agent reports the block in its Bot HQ reply. Protected visual takeover for other same-browser challenges remains a rollout check.

The Owner can explicitly lock or unlock using `sudo /usr/local/libexec/quantself-vaultwarden-keys --lock` or `--unlock`. The lock cancels an active request, closes the protected browser and survives service restart. Idle expiry drops the vault key and closes the protected browser. The next permitted request unlocks the vault on demand, and protected website access requires a fresh sign-in. If a client flood prevents the lock request, the Owner can stop the socket and service and create `/var/lib/quantself-vaultwarden/owner-locked` before starting the socket again. Use the website's session controls to revoke the session on the site itself.

Run the offline tests with `python3 -m unittest discover -s agents/vaultwarden`. They use a fake Bitwarden CLI and fake credentials. To include the local fake HTTPS site against real Chromium, run the same tests with the pinned Playwright environment, libpsl, OpenSSL and `VAULTWARDEN_TEST_CHROMIUM` set to the browser executable. The fixture uses isolated browser profiles and a temporary test certificate.

On a disposable Linux machine with Chromium and the pinned Playwright wheels available, run `sudo python3 -I agents/vaultwarden/verify-linux-isolation.py PLAYWRIGHT_MODULE_DIRECTORY /usr/bin/chromium`. Use a readable scratch checkout and an unpacked wheel directory readable by the fixture accounts `nobody` and `www-data`. Preserve executable permissions on Playwright's `driver/node`. The probe uses a fake credential and a temporary activation socket with the production permissions. It checks that the Agent UID can read its allowlisted startup key and is denied the credential, Chrome profile, actual DevTools handles and Owner controls. Repeat the isolation and reboot checks under the deployed Debian systemd units before live use.

## Enable business mailbox reading

1. In [Purelymail Account Admin](https://purelymail.com/manage/login), open the Agent's `@dawnshiftagency.com` user and create a dedicated app password with only IMAP enabled.
2. In the private Vaultwarden web vault at the configured `VAULTWARDEN_ORIGIN`, save a Login item with the full mailbox address and app password. Use the Agent's vault or an Owner collection shared solely with that Agent. Hand off only the item UUID. Use a separate item from website recipes.
3. After the approved Agent rollout, pass that UUID as the third argument to the Vaultwarden installer. It derives the pinned mailbox address from the installed Agent role. The Agent installer loads the updated tool. [Hermes setup spec](../../docs/agents/hermes-setup.md#agent-business-mailbox-handoff-360)
4. Through Bot HQ, ask the Agent to find and read its own synthetic #360 message with `quantself_business_mail` and report status only. Verify the service refuses requests targeting either other Agent's inbox. Record the outcomes in #360.

For cutoff, revoke the app password in Purelymail. To rotate it, update the same login item. Each read syncs Vaultwarden and requires current access to the configured login.

## Enable Tyler's self-service website pilot

After each Agent's named rollout approval, append `--self-service` after their existing business mail item UUID in the installer command. Use `quantself_website_account` with the public HTTPS site and username. **Create** only for a new Agent-owned account. If email verification is requested, read the code with `quantself_business_mail` and pass it to **verify_email** for the same account. Report status in chat. The generated password and any detected TOTP seed go directly to the private Login in Vaultwarden.

Same-origin scripts can render native login forms in this mode. The page receives placeholder password and verification code values. The service inserts the private values into the one checked HTTPS POST. Protected reads return bounded text with page scripts disabled. Sites that require a JavaScript-handled credential POST or an outside challenge provider can return a blocked status.

Use the same site and username for protected reads, sign-out, reopening the private browser, and signing in again. If account creation is unconfirmed, the next attempt checks the saved item and site before any further submission. Leave other sites on their reviewed recipe path.
