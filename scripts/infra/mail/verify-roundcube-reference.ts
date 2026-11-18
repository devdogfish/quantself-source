import { deepStrictEqual } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { issueRoundcubeOriginal } from "../../../apps/api/src/roundcube-original-issuer";

// Generate disposable keys in memory. Pass only the public key and references to PHP.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" });
if (!jwk.x) throw new Error("Ed25519 public key unavailable");

const audience = "roundcube.jobs.example.test";
const account = "jobs@example.test";
const folder = 'Jobs & archive/Replies "été" \\raw';
const messageId = "<reply.42@example.test>";
const now = 1_795_000_000;

function mintEncoded(payload: string) {
  const signed = "qs-original-v1." + payload;
  return signed + "." + sign(null, Buffer.from(signed), privateKey).toString("base64url");
}

function encode(json: string) {
  return Buffer.from(json).toString("base64url");
}

function mint(claims: unknown[]) {
  return mintEncoded(encode(JSON.stringify(claims)));
}

function claims(scope: string, part: string | null): unknown[] {
  return [audience, account, folder, 42, 120, messageId, scope, part, now - 30, now + 30];
}

function change(position: number, value: unknown) {
  const changed = claims("show", null);
  changed[position] = value;
  return mint(changed);
}

const context = { audience, account, scope: "show", part: null as string | null, now };
const show = claims("show", null);
const valid = mint(show);
const [, , signature] = valid.split(".");
const changedUid = [...show];
changedUid[3] = 43;
const cases = [
  { name: "show", token: valid, accepted: true },
  { name: "source", token: mint(claims("source", null)), scope: "source", accepted: true },
  { name: "attachment", token: mint(claims("attachment", "2.1")), scope: "attachment", part: "2.1", accepted: true },
  { name: "wrong account", token: valid, account: "other@example.test" },
  { name: "wrong audience", token: valid, audience: "other-roundcube.example.test" },
  { name: "wrong scope", token: valid, scope: "source" },
  { name: "wrong part", token: mint(claims("attachment", "2.1")), scope: "attachment", part: "2.2" },
  { name: "expired at exact boundary", token: valid, now: now + 30 },
  { name: "future issue time", token: change(8, now + 1) },
  { name: "TTL exceeds limit", token: change(9, now + 301) },
  { name: "UID changed without signing", token: "qs-original-v1." + encode(JSON.stringify(changedUid)) + "." + signature },
  { name: "signature changed", token: valid.slice(0, -signature.length) + (signature[0] === "A" ? "B" : "A") + signature.slice(1) },
  { name: "signature from another signing key", token: valid.slice(0, -signature.length) +
    sign(null, Buffer.from(valid.slice(0, -signature.length - 1)), generateKeyPairSync("ed25519").privateKey).toString("base64url") },
  { name: "noncanonical base64", token: valid + "=" },
  { name: "version changed", token: valid.replace("v1.", "v2.") },
  { name: "unsigned coordinates", token: encode(JSON.stringify(show)) },
  { name: "extra claim", token: mint([...show, 42]) },
  { name: "duplicate JSON field", token: mintEncoded(encode('{"uid":42,"uid":43}')) },
  { name: "UID encoded as a string", token: change(3, "42") },
  { name: "UID exceeds IMAP range", token: change(3, 4294967296) },
  { name: "invalid epoch", token: change(4, 0) },
  { name: "two message IDs", token: change(5, "<first@example.test> <second@example.test>") },
  { name: "folder header injection", token: change(2, "INBOX\r\n") },
  { name: "combined UID and folder", token: change(3, "42-other") },
  { name: "leading zero in part", token: mint(claims("attachment", "02.1")), scope: "attachment", part: "02.1" },
  { name: "unscoped part", token: change(7, "2"), part: "2" },
].map(test => ({ ...context, ...test }));

const issued = await issueRoundcubeOriginal({
  owner: { id: "owner", email: "owner@example.test", name: "Fixture owner" },
  client: { id: "browser", kind: "web", name: "Fixture browser" },
  permissions: ["jobs:read"],
}, "application", {
  baseUrl: "https://roundcube.jobs.example.test/",
  audience,
  mailboxAccount: account,
  signingKey: privateKey,
  includeSource: true,
  now: () => now,
  lookup: async ({ ownerId, applicationId }) => {
    const message = { account, folder, uid: 42, uidValidity: 120, messageId };
    return { kind: "complete", association: { ownerId, applicationId, message }, observedAt: now,
      matches: [{ ...message, attachmentParts: ["2", "3.1"] }] };
  },
});
if (issued.kind !== "issued") throw new Error("Owner fixture did not issue a reference");
const issuedToken = new URL(issued.url).searchParams.get("_ref");
if (!issuedToken) throw new Error("Issuer did not return the signed reference");
const bundle = new URL(issued.url).searchParams.get("_parts");
if (!bundle) throw new Error("Issuer did not return detached part signatures");
const sourceSignature = new URL(issued.url).searchParams.get("_source");
if (!sourceSignature) throw new Error("Issuer did not return the detached source signature");
const [firstPart, secondPart] = bundle.split("!");
const child = (part: string) => mint([
  audience, account, folder, 42, 120, messageId, "attachment", part, now, issued.expiresAt,
]);
const bundleCase = { ...context, token: issuedToken, bundle };
const expected = { 2: child("2"), "3.1": child("3.1") };
const expectedSource = mint([audience, account, folder, 42, 120, messageId, "source", null, now, issued.expiresAt]);
const sourceCase = { ...bundleCase, sourceSignature };
const largestBundle = Object.fromEntries(Array.from({ length: 16 }, (_, index) => {
  const part = [String(100_000_000 + index), ...Array(7).fill("999999999")].join(".");
  return [part, child(part)];
}));
const maximum = Object.entries(largestBundle).map(([part, token]) => part + "~" + token.split(".")[2]).join("!");
deepStrictEqual(maximum.length, 2671);
const bundles = [
  { ...bundleCase, name: "raw-byte reconstruction with escaped and non-ASCII folder", expected },
  { ...bundleCase, name: "maximum-sized bundle", bundle: maximum, expected: largestBundle },
  { ...bundleCase, name: "expired parent", now: issued.expiresAt },
  { ...bundleCase, name: "duplicate", bundle: firstPart + "!" + firstPart },
  { ...bundleCase, name: "part label swapped", bundle: firstPart.replace(/^2~/, "3.1~") },
  { ...bundleCase, name: "wrong detached signature", bundle: firstPart + "!" + secondPart.replace(/.$/, ch => ch === "A" ? "B" : "A") },
  { ...bundleCase, name: "over-limit bundle", bundle: "x".repeat(2672) },
  { ...bundleCase, name: "over-limit entry count", bundle: Array(17).fill(firstPart).join("!") },
  { ...bundleCase, name: "wrong parent", token: mint(claims("show", null)) },
  { ...bundleCase, name: "empty bundle", bundle: "" },
  { ...sourceCase, name: "source and parts preserve original parent bytes", expected, expectedSource },
  { ...sourceCase, name: "source without parts", bundle: null, expected: {}, expectedSource },
  { ...sourceCase, name: "attachment signature cannot issue source", sourceSignature: firstPart.split("~")[1] },
  { ...sourceCase, name: "source expires with parent", now: issued.expiresAt },
  { ...sourceCase, name: "source with short signature", sourceSignature: sourceSignature.slice(1) },
];
cases.push(
  { ...context, name: "Owner-issued lifecycle reference", token: issuedToken, accepted: true },
  { ...context, name: "Owner-issued reference on wrong mailbox", token: issuedToken, account: "other@example.test" },
  { ...context, name: "Owner-issued reference at expiry", token: issuedToken, now: issued.expiresAt },
);

const directory = fileURLToPath(new URL("./roundcube-reference", import.meta.url));
const image = "docker.io/roundcube/roundcubemail@sha256:37a90cb245228080779462fd120db3d64335e1abbec33bda94ca18c9e163881b";
const run = (args: string[]) => Bun.spawnSync(["docker", ...args]);
const dockerContext = process.env.ROUNDCUBE_FIXTURE_DOCKER_CONTEXT ?? run(["context", "show"]).stdout.toString().trim();
const endpoint = run(["context", "inspect", dockerContext, "--format", "{{.Endpoints.docker.Host}}"]);
if (endpoint.exitCode !== 0 || !endpoint.stdout.toString().trim().startsWith("unix:///")) {
  throw new Error("Use a local Unix-socket Docker context");
}

const result = Bun.spawnSync([
  "docker", "--context", dockerContext, "run", "--rm", "-i", "--pull=never", "--network", "none",
  "--read-only", "--cap-drop", "ALL", "--entrypoint", "php",
  "--mount", `type=bind,src=${directory},dst=/fixture,readonly`,
  image, "/fixture/verify-fixture.php",
], { stdin: Buffer.from(JSON.stringify({ key: Buffer.from(jwk.x, "base64url").toString("base64"), cases, bundles })) });

if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
const { references: outcomes, bundles: bundleOutcomes } = JSON.parse(result.stdout.toString());
deepStrictEqual(outcomes.length, cases.length);
for (const [index, test] of cases.entries()) {
  deepStrictEqual(outcomes[index], test.accepted ? {
    account, folder, uid: 42, uidValidity: 120, messageId, scope: test.scope, part: test.part,
  } : null, test.name);
}
deepStrictEqual(bundleOutcomes.length, bundles.length);
for (const [index, test] of bundles.entries()) {
  deepStrictEqual(bundleOutcomes[index], test.expected
    ? { parts: test.expected, source: "expectedSource" in test ? test.expectedSource : null }
    : null, test.name);
}
console.log(`PASS ${cases.length} references and ${bundles.length} detached bundles checked by pinned Roundcube PHP`);
