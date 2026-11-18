import { expect, test } from "bun:test";
import { verifyLiveEvidence, verifySnapshots } from "./check-girke-dns";

const ttl = 1800;
const root = { name: "@", type: "A", address: "192.0.2.1", ttl };
const privateHost = { name: "private-fixture", type: "A", address: "100.64.0.1", ttl };
const mail = { name: "@", type: "MX", exchange: "mail.example.invalid", preference: 10, ttl };
const dkim = { name: "selector._domainkey", type: "TXT", value: "v=DKIM1; p=example", ttl };
const alias = { name: "public-fixture", type: "CNAME", cname: "target.example.invalid", ttl };
const records = [root, privateHost, mail, dkim];
const zone = (items: object[]) => ({ items, total: items.length });
const baseline = zone(records);
const inventory = {
  before: { "private-fixture": "internal" },
  after: { "private-fixture": "internal", "public-fixture": "public" },
};

test("accepts reviewed records and ignores record order", () => {
  const expected = zone([...records, alias]);
  const after = zone([...expected.items].reverse());
  const plan = verifySnapshots(baseline, baseline, expected, inventory);
  expect(plan.records).toBe(5);
  expect(verifySnapshots(baseline, baseline, expected, inventory, after)).toEqual(plan);
});

test("rejects incomplete pages, baseline drift and unexpected outcomes", () => {
  expect(() => verifySnapshots(baseline, { ...baseline, total: 8 }, baseline, inventory))
    .toThrow("Incomplete Spaceship snapshot");
  expect(() => verifySnapshots(baseline, zone([root, privateHost]), baseline, inventory))
    .toThrow("differs from the accepted baseline");
  expect(() => verifySnapshots(baseline, baseline, baseline, inventory, zone([...records, alias])))
    .toThrow("differs from the approved result");
});

test("protects portfolio, mail and delegation records", () => {
  for (const record of [
    { ...root, address: "192.0.2.3" },
    { ...mail, preference: 20 },
    { ...dkim, value: "v=DKIM1; p=changed" },
    { name: "delegate", type: "NS", nameserver: "ns.example.invalid", ttl },
    { name: "_vercel", type: "TXT", value: "vc-domain-verify=fixture", ttl },
  ]) {
    const expected = zone([...records.filter(current => current.name !== record.name ||
      current.type !== record.type), record]);
    expect(() => verifySnapshots(baseline, baseline, expected, inventory)).toThrow("protected");
  }
});

test("requires a classification and keeps internal addresses on the tailnet", () => {
  const expected = zone([...records, alias]);
  expect(() => verifySnapshots(baseline, baseline, expected, { ...inventory, after: inventory.before }))
    .toThrow("missing from the private inventory");

  const exposedPrivate = zone([root, mail, dkim, { ...privateHost, address: "192.0.2.2" }]);
  expect(() => verifySnapshots(baseline, baseline, exposedPrivate, inventory))
    .toThrow("does not match its internal/public classification");
  const hiddenPublic = zone([...records, { ...privateHost, name: "public-fixture" }]);
  expect(() => verifySnapshots(baseline, baseline, hiddenPublic, inventory))
    .toThrow("does not match its internal/public classification");

  const ipv6 = zone([...records, { ...privateHost, type: "AAAA", address: "fd7a:115c:a1e0:0000::1" }]);
  expect(verifySnapshots(baseline, baseline, ipv6, inventory).records).toBe(5);
});

const signedDs = { keyTag: 1, algorithm: 13, digestType: 2, digest: "AABB" };
const rdap = {
  nameservers: ["launch2.spaceship.net", "launch1.spaceship.net"].map(ldhName => ({ ldhName })),
  entities: [{ roles: ["registrar"], publicIds: [{ type: "IANA Registrar ID", identifier: "3862" }] }],
  secureDNS: { delegationSigned: true, dsData: [signedDs] },
};
const answer = (type: number, data: string) => ({
  Status: 0, AD: true, Answer: [{ type, data, name: "girke.dev." }],
});
const ds = answer(43, "1 13 2 aabb");
const apex = answer(1, root.address);
const vercel = new Response(null, { headers: { server: "Vercel", "x-vercel-id": "fixture" } });

test("checks Spaceship delegation, the current DS and the signed Vercel apex", () => {
  expect(verifyLiveEvidence(rdap, ds, apex, apex, vercel).dsSha256).toHaveLength(64);
  expect(() => verifyLiveEvidence({ ...rdap, nameservers: [{ ldhName: "ns.example.invalid" }] },
    ds, apex, apex, vercel)).toThrow("delegation differs");
  expect(() => verifyLiveEvidence(rdap, answer(43, "2 13 2 CCDD"), apex, apex, vercel))
    .toThrow("DS differs");
  expect(() => verifyLiveEvidence(rdap, ds, { ...apex, AD: false }, apex, vercel)).toThrow("DNSSEC validation");
  expect(() => verifyLiveEvidence(rdap, ds, apex, apex, new Response(null))).toThrow("Vercel response");
});
