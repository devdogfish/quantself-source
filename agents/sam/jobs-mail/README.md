# Sam’s Jobs inbox

Sam uses this service to handle the dedicated Jobs inbox from his regular Jobs work. It runs only on Sam’s Atlas host. A local Unix socket accessible to Sam’s `hermes` group and checked against his account UID distinguishes it from the other Agents’ mail tools. A systemd worker under a separate OS account receives one request. Reads use `EXAMINE` and bounded `BODY.PEEK` over verified TLS. Moves are restricted to INBOX and Archive. Seen and flagged writes target one flag through UID STORE. Purelymail refuses conditional STORE, so Undo checks the recorded message revision immediately before changing the flag. The server does not provide a compare-and-set guarantee across mailbox clients.

When Sam opens a reply, the tool uses a recognized Purelymail SMTP trace and a single exact Jobs lookup to look for its Application Address. A recorded SES thread reference without a verified recipient is a candidate for review. Conflicting or missing evidence stays in Bot HQ for the Owner. Review HTML-only or truncated content in the Owner’s original mail app.

## Install and qualify on Sam

1. Install `agents/sam/jobs-mail/install.sh` as root. Use the matching Sam Agent installer to load the Jobs mail plugin and restart Sam’s gateway in the approved window. The socket installer leaves it disabled.
2. The Owner creates the dedicated Purelymail app password named `Quantself Sam Jobs reader` for `luigi@luigigirke.com` with IMAP as its only scope. Enter it on Sam’s root console through `systemd-ask-password`, piping its output into `systemd-creds encrypt --with-key=host --name=imap - /etc/quantself-jobs-mail/imap.cred`. Mark the encrypted file mode 0600 and leave the directory mode 0700.
3. Start `quantself-jobs-mail.socket` and verify its socket is mode 0660 and owned by `root:hermes`. Confirm as `hermes` that a list request succeeds and the encrypted credential directory is inaccessible. Confirm a different local user cannot connect.
4. Read a known synthetic Jobs reply through Sam’s Hermes tool. Record only its status and the synthetic marker. Verify a read leaves flags unchanged. On the synthetic reply, exercise mark, move and Undo with a saved command ID. A repeated ID must replay its receipt. Check that stale mailbox references, arbitrary folders, deletion and SMTP commands are rejected.
5. Stop the socket and prove a new Sam read fails. Start it again and check the synthetic read succeeds. Enable the socket for normal use after verification. The Owner can revoke the app password independently, as demonstrated in the #278 trial.

Stop and disable the socket to remove access. Stopping it also stops accepted service instances. The Owner can independently revoke the upstream password in Purelymail. Keep credential material and message bodies out of logs, Git, and Bot HQ verification transcripts.

Mailbox action receipts and Undo state live in `/var/lib/quantself-jobs-mail/actions.db` under the service account. An uncertain operation keeps its reservation. Reconcile it before issuing a new command. Moving changes the folder and UID, so keep a linked original in place while Quantself references its current location. Employer sending uses a separate SES path.


## Enable employer replies

Bundle the private SES worker from this revision:

```bash
bun build scripts/jobs/send-reply-worker.ts --target=bun --minify --outfile /tmp/send-reply.js
```

Install the units with `agents/sam/jobs-mail/install.sh /tmp/send-reply.js`. On Sam’s host, the Owner saves a separate access key for the existing Jobs-only SES principal. Use an AWS profile named `sam-jobs-replies`, encrypted with systemd credential name `qs196-jobs-ses` at `/etc/credstore.encrypted/qs196-jobs-ses`, mode 0600. Keep the working Mac runner key available. The scope is SES SendEmail in Canada Central from valid Application Addresses. Sam cannot read the key.

The tool accepts a message UID, mailbox revision, plain-text reply and command ID. The service derives the sender, recipient, subject and thread from the stored message. It requires aligned incoming authentication, a registered submitted Job Application, and three minutes since that application record changed. Unknown or conflicting evidence stays with the Owner. A durable receipt binds the attempt to the source thread and prevents duplicate dispatch after a lost acknowledgement. Reconcile an uncertain receipt before following up again. A saved SES receipt cannot be undone.

Without the credential, mailbox actions still work and reply requests report `sender_unconfigured`. Revoke only this access key to remove sending. No polling process is installed.
