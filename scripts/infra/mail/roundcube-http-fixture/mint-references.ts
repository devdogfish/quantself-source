import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const { x } = publicKey.export({ format: "jwk" });
if (!directory || !x) throw new Error("Fixture state directory or Ed25519 key unavailable");

const now = Math.floor(Date.now() / 1000);
function mint(scope: string, part: string | null, uidValidity: number, expiresAt = now + 240) {
  const claims = [
    "roundcube.jobs.example.test", "jobs@example.test", "INBOX", 42, uidValidity,
    "<roundcube-proof@example.test>", scope, part, now - 30, expiresAt,
  ];
  const signed = "qs-original-v1." + Buffer.from(JSON.stringify(claims)).toString("base64url");
  return signed + "." + sign(null, Buffer.from(signed), privateKey).toString("base64url");
}

const scopes = [["show", null], ["source", null], ["attachment", "2"]] as const;
const references = Object.fromEntries(scopes.map(([scope, part]) => [
  scope, { current: mint(scope, part, 120), stale: mint(scope, part, 119), expired: mint(scope, part, 120, now - 1) },
]));
const retryExpiry = now + 16;
const retry = process.env.QS_ROUNDCUBE_FIXTURE_LOGIN_RETRY === "1"
  ? { retry: { token: mint("show", null, 120, retryExpiry), expiry: retryExpiry } }
  : {};
writeFileSync(join(directory, "public.key"), Buffer.from(x, "base64url"), { mode: 0o644 });
writeFileSync(join(directory, "references.json"), JSON.stringify({ ...references, ...retry }), { mode: 0o644 });
writeFileSync(join(directory, "attachment-links.json"), JSON.stringify({
  2: references.attachment.current,
  3: mint("attachment", "3", 120),
}), { mode: 0o644 });
