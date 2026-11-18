import type { AccessContext } from "@quantself/auth";
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { issueRoundcubeOriginal } from "./roundcube-original-issuer";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const access: AccessContext = {
  owner: { id: "owner-1", name: "Fixture owner", email: "owner@example.test" },
  client: { id: "browser-1", name: "Fixture browser", kind: "web" },
  permissions: ["jobs:read"],
};
const message = {
  account: "jobs@example.test",
  folder: "INBOX",
  uid: 42,
  uidValidity: 120,
  messageId: "<reply@example.test>",
};
const now = 1_795_000_000;
const association = { ownerId: access.owner.id, applicationId: "job-1", message };
const complete = { kind: "complete" as const, association, observedAt: now, matches: [message] };
const dependencies = {
  baseUrl: "https://roundcube.jobs.example.test/",
  audience: "roundcube.jobs.example.test",
  mailboxAccount: message.account,
  signingKey: privateKey,
  now: () => now,
  lookup: async () => complete,
};

test("one owner-scoped lookup issues a signed show URL with no caller coordinates", async () => {
  let calls = 0;
  const result = await issueRoundcubeOriginal(access, "job-1", {
    ...dependencies,
    lookup: async request => {
      calls++;
      expect(request).toEqual({ ownerId: "owner-1", applicationId: "job-1" });
      return complete;
    },
  });
  expect(calls).toBe(1);
  expect(result.kind).toBe("issued");
  if (result.kind !== "issued") return;
  const url = new URL(result.url);
  expect(url.origin).toBe("https://roundcube.jobs.example.test");
  expect([...url.searchParams.keys()]).toEqual(["_task", "_action", "_ref"]);
  expect(url.searchParams.get("_action")).toBe("show");
  expect(result.expiresAt).toBe(now + 120);
});

test("anonymous, API-key, and browser without Jobs permission stop before lookup", async () => {
  const lookup = async () => { throw new Error("Unauthorized lookup"); };
  for (const subject of [
    null,
    { ...access, client: { ...access.client, kind: "api-key" as const } },
    { ...access, permissions: [] },
  ]) {
    expect(await issueRoundcubeOriginal(subject, "job-1", { ...dependencies, lookup })).toEqual({ kind: "denied" });
  }
});

const declined = [
  ["missing association", { ...complete, association: null }, "missing"],
  ["incomplete lookup", { kind: "unavailable" }, "unverifiable"],
  ["multiple matches", { ...complete, matches: [message, { ...message, uid: 43 }] }, "ambiguous"],
  ["no exact match", { ...complete, matches: [] }, "missing"],
  ["other owner", { ...complete, association: { ...association, ownerId: "other" } }, "unverifiable"],
  ["other application", { ...complete, association: { ...association, applicationId: "job-2" } }, "unverifiable"],
  ["legacy folder and UID", { ...complete, association: { ...association, message: { folder: "INBOX", uid: 42 } } }, "unverifiable"],
  ["wrong mailbox", { ...complete, matches: [{ ...message, account: "other@example.test" }] }, "stale"],
  ["moved message", { ...complete, matches: [{ ...message, folder: "Archive" }] }, "stale"],
  ["reused UID after reset", { ...complete, matches: [{ ...message, uidValidity: 121 }] }, "stale"],
  ["different Message-ID at same UID", { ...complete, matches: [{ ...message, messageId: "<other@example.test>" }] }, "stale"],
  ["cached observation", { ...complete, observedAt: now - 1 }, "stale"],
  ["future observation", { ...complete, observedAt: now + 1 }, "stale"],
] as const;

test.each(declined)("%s returns no reference", async (_name, evidence, kind) => {
  const lookup: Parameters<typeof issueRoundcubeOriginal>[2]["lookup"] = async () => evidence;
  expect(await issueRoundcubeOriginal(access, "job-1", { ...dependencies, lookup })).toEqual({ kind });
});

test("rejects an observation that ages out while lookup completes", async () => {
  let clock = now;
  const result = await issueRoundcubeOriginal(access, "job-1", {
    ...dependencies,
    now: () => clock,
    lookup: async () => {
      clock += 6;
      return complete;
    },
  });
  expect(result).toEqual({ kind: "stale" });
});

test("invalid issuer config or failed lookup leaves the reference unavailable", async () => {
  for (const override of [
    { baseUrl: "http://roundcube.jobs.example.test/" },
    { baseUrl: "https://roundcube.jobs.example.test/?_action=show" },
    { signingKey: publicKey },
    { lookup: async () => { throw new Error("Fixture lookup failed"); } },
  ]) {
    expect(await issueRoundcubeOriginal(access, "job-1", { ...dependencies, ...override })).toEqual({ kind: "unverifiable" });
  }
});

test.each([[false], [true]] as const)("attachment handoff with includeSource=%s uses one bounded lookup", async includeSource => {
  const attachmentParts = Array.from({ length: 16 }, (_, index) =>
    [String(100_000_000 + index), ...Array(7).fill("999999999")].join("."));
  let calls = 0;
  const lookup = async () => {
    calls++;
    return { ...complete, matches: [{ ...message, attachmentParts }] };
  };
  const first = await issueRoundcubeOriginal(access, "job-1", { ...dependencies, lookup, includeSource });
  expect(first.kind).toBe("issued");
  expect(calls).toBe(1);
  if (first.kind !== "issued") return;
  const target = new URL(first.url);
  expect(target.searchParams.get("_parts")?.length).toBe(2671);
  expect(target.searchParams.get("_source")?.length).toBe(includeSource ? 86 : undefined);
  const exactPath = "/" + "x".repeat(4096 - target.search.length - 1);
  const size = (path: string) => issueRoundcubeOriginal(access, "job-1", {
    ...dependencies, lookup, includeSource, baseUrl: new URL(path, dependencies.baseUrl).href,
  });
  expect((await size(exactPath)).kind).toBe("issued");
  expect((await size(exactPath + "x")).kind).toBe("unverifiable");
});

test("source issuance does not need attachment discovery", async () => {
  const result = await issueRoundcubeOriginal(access, "job-1", { ...dependencies, includeSource: true });
  expect(result.kind).toBe("issued");
  if (result.kind !== "issued") return;
  const query = new URL(result.url).searchParams;
  expect(query.get("_source")).toMatch(/^[A-Za-z0-9_-]{86}$/);
  expect(query.has("_parts")).toBe(false);
});

test("issuer cannot sign duplicate, noncanonical or excessive part lists", async () => {
  for (const attachmentParts of [["2", "2"], ["2.MIME"], ["02"], Array.from({ length: 17 }, (_, index) => String(index + 1))]) {
    const lookup = async () => ({ ...complete, matches: [{ ...message, attachmentParts }] });
    expect(await issueRoundcubeOriginal(access, "job-1", { ...dependencies, lookup })).toEqual({ kind: "unverifiable" });
  }
});
