import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const domain = "girke.dev";
const nameservers = ["launch1.spaceship.net", "launch2.spaceship.net"];
const hostRecordTypes = new Set(["A", "AAAA", "ALIAS", "CNAME", "HTTPS", "SVCB"]);
const dnsRecord = z.object({
  name: z.string().regex(/^(?:@|(?:[a-z0-9_*-]+\.)*[a-z0-9_*-]+)$/i),
  type: z.string().regex(/^[A-Z][A-Z0-9]*$/),
  ttl: z.number().int().nonnegative(),
}).passthrough();
const zonePage = z.object({
  items: z.array(dnsRecord).min(1),
  total: z.number().int().positive(),
});
const hostClasses = z.record(z.string(), z.enum(["internal", "public"]));
const inventorySchema = z.object({ before: hostClasses, after: hostClasses });
type DnsRecord = z.infer<typeof dnsRecord>;

function requirePolicy(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sortedRecords(records: DnsRecord[]) {
  return records.map(record => JSON.stringify(Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  ))).sort();
}

function readZone(input: unknown) {
  const result = zonePage.safeParse(input);
  requirePolicy(result.success, "Invalid Spaceship snapshot.");
  const { items, total } = result.data;
  requirePolicy(items.length === total, "Incomplete Spaceship snapshot. Include every page.");
  requirePolicy(new Set(sortedRecords(items)).size === total, "Spaceship snapshot contains duplicate records.");
  return items;
}

function protectedRecord({ name, type, value }: DnsRecord) {
  const labels = name.toLowerCase().split(".");
  return name === "@" || name.toLowerCase() === "www" || labels.includes("_vercel") ||
    ["MX", "CAA", "NS", "DS"].includes(type) || labels.includes("_domainkey") ||
    labels.includes("_dmarc") || labels.includes("_mta-sts") ||
    labels.some((label, index) => label === "_smtp" && labels[index + 1] === "_tls") ||
    labels.includes("mta-sts") ||
    (type === "TXT" && typeof value === "string" && /^v=spf1\b/i.test(value));
}

function isTailnetAddress(record: DnsRecord) {
  const { address } = record;
  if (typeof address !== "string") return false;
  if (record.type === "A" && isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return record.type === "AAAA" && isIP(address) === 6 &&
    new URL(`http://[${address}]/`).hostname.startsWith("[fd7a:115c:a1e0:");
}

export function verifySnapshots(baselineInput: unknown, beforeInput: unknown, expectedInput: unknown,
  inventoryInput: unknown, afterInput?: unknown) {
  const [baseline, before, expected] = [baselineInput, beforeInput, expectedInput].map(readZone);
  const inventory = inventorySchema.safeParse(inventoryInput);
  requirePolicy(inventory.success, "Invalid private hostname inventory.");
  requirePolicy(isDeepStrictEqual(sortedRecords(baseline), sortedRecords(before)),
    "The before snapshot differs from the accepted baseline.");
  requirePolicy(isDeepStrictEqual(sortedRecords(before.filter(protectedRecord)),
    sortedRecords(expected.filter(protectedRecord))), "The plan changes protected portfolio, mail, CAA, or delegation records.");

  for (const [zone, classes] of [[before, inventory.data.before], [expected, inventory.data.after]] as const) {
    for (const record of zone) {
      if (record.type === "A" || record.type === "AAAA") {
        const family = record.type === "A" ? 4 : 6;
        requirePolicy(typeof record.address === "string" && isIP(record.address) === family,
          "A Spaceship address record is malformed.");
      }
      const name = record.name.toLowerCase();
      if (name === "@" || !hostRecordTypes.has(record.type)) continue;
      const classification = Object.hasOwn(classes, name) && classes[name];
      requirePolicy(classification, "A service hostname is missing from the private inventory.");
      requirePolicy((classification === "internal") === isTailnetAddress(record),
        "A service record does not match its internal/public classification.");
    }
  }

  const planned = sortedRecords(expected);
  if (afterInput !== undefined) {
    requirePolicy(isDeepStrictEqual(planned, sortedRecords(readZone(afterInput))),
      "The after snapshot differs from the approved result.");
  }
  return { records: planned.length, sha256: createHash("sha256").update(JSON.stringify(planned)).digest("hex") };
}

const registryResponse = z.object({
  entities: z.array(z.object({ roles: z.array(z.string()), publicIds: z.array(z.object({
    type: z.string(),
    identifier: z.string(),
  })).optional() })),
  nameservers: z.array(z.object({ ldhName: z.string() })),
  secureDNS: z.object({
    delegationSigned: z.literal(true),
    dsData: z.array(z.object({
      keyTag: z.number(),
      algorithm: z.number(),
      digestType: z.number(),
      digest: z.string().regex(/^[a-f0-9]+$/i),
    })).min(1),
  }),
});
const dnsAnswer = z.object({
  Status: z.literal(0),
  AD: z.literal(true),
  Answer: z.array(z.object({ name: z.string(), type: z.number(), data: z.string() })),
});

function matchingAnswers(input: unknown, type: number) {
  const result = dnsAnswer.safeParse(input);
  requirePolicy(result.success, "Public DNS response failed DNSSEC validation.");
  const records = result.data.Answer
    .filter(record => record.type === type && record.name.replace(/\.$/, "").toLowerCase() === domain)
    .map(record => record.data.toUpperCase()).sort();
  requirePolicy(records.length, "Public DNS response is missing the expected signed records.");
  return records;
}

export function verifyLiveEvidence(rdap: unknown, ds: unknown, googleA: unknown, cloudflareA: unknown, portfolio: Response) {
  const registry = registryResponse.safeParse(rdap);
  requirePolicy(registry.success, "Registry data is incomplete or DNSSEC is disabled.");
  requirePolicy(registry.data.entities.some(entity => entity.roles.includes("registrar") &&
    entity.publicIds?.some(id => id.type === "IANA Registrar ID" && id.identifier === "3862")),
  "Registry registrar is not Spaceship.");
  requirePolicy(isDeepStrictEqual(registry.data.nameservers.map(ns => ns.ldhName.toLowerCase()).sort(), nameservers),
    "Registry delegation differs from the Spaceship nameservers.");

  const registryDs = registry.data.secureDNS.dsData.map(record =>
    [record.keyTag, record.algorithm, record.digestType, record.digest.toUpperCase()].join(" ")).sort();
  requirePolicy(isDeepStrictEqual(matchingAnswers(ds, 43), registryDs), "Validated DS differs from the registry.");
  requirePolicy(isDeepStrictEqual(matchingAnswers(googleA, 1), matchingAnswers(cloudflareA, 1)),
    "Public resolvers disagree on the signed portfolio address.");
  requirePolicy(portfolio.ok && portfolio.headers.get("server") === "Vercel" && portfolio.headers.has("x-vercel-id"),
    "The portfolio apex did not return a successful Vercel response.");
  return { dsSha256: createHash("sha256").update(JSON.stringify(registryDs)).digest("hex") };
}

async function readRemote(url: string, label: string, headers?: HeadersInit) {
  try {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(8000) });
    requirePolicy(response.ok, "Unsuccessful response.");
    return response;
  } catch {
    throw new Error(`${label} lookup failed.`);
  }
}

async function readJson(url: string, label: string, accept = "application/dns-json") {
  const response = await readRemote(url, label, { accept });
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function checkLiveDns() {
  const [rdap, ds, googleA, cloudflareA, portfolio] = await Promise.all([
    readJson(`https://pubapi.registry.google/rdap/domain/${domain}`, "Registry RDAP", "application/rdap+json"),
    readJson(`https://dns.google/resolve?name=${domain}&type=DS&do=1`, "Google DS"),
    readJson(`https://dns.google/resolve?name=${domain}&type=A&do=1`, "Google apex"),
    readJson(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A&do=1`, "Cloudflare resolver apex"),
    readRemote(`https://${domain}/`, "Portfolio"),
  ]);
  await portfolio.body?.cancel();
  return verifyLiveEvidence(rdap, ds, googleA, cloudflareA, portfolio);
}

async function readPrivateJson(path: string, label: string) {
  try {
    return await Bun.file(path).json();
  } catch {
    throw new Error(`Could not read the private ${label} JSON file.`);
  }
}

if (import.meta.main) {
  try {
    const [command, ...paths] = process.argv.slice(2);
    if (command === "check" && paths.length === 0) {
      console.log(JSON.stringify(await checkLiveDns()));
    } else if ((command === "plan" && paths.length === 4) || (command === "compare" && paths.length === 5)) {
      const labels = ["baseline", "before", "expected", "inventory", "after"];
      const [baseline, before, expected, inventory, after] = await Promise.all(
        paths.map((path, index) => readPrivateJson(path, labels[index])),
      );
      console.log(JSON.stringify(verifySnapshots(baseline, before, expected, inventory, after)));
    } else {
      throw new Error("Usage: bun run dns:girke check | plan BASELINE BEFORE EXPECTED INVENTORY | compare BASELINE BEFORE EXPECTED INVENTORY AFTER");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "DNS check failed.");
    process.exitCode = 1;
  }
}
