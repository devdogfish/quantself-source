/** Run with bun - inside the private Keep API container. Credentials stay inside it. */
// Keep this probe self-contained for the documented bun stdin invocation.
function expectedProbeOrigin(name: string): string {
  try {
    const value = new URL(process.env[name] ?? "");
    if (value.protocol === "https:" && value.hostname && !value.username &&
      !value.password && value.port !== "0" && value.pathname === "/" && !value.search && !value.hash) {
      return value.origin;
    }
  } catch {
    // A malformed private input must fail before any probe traffic.
  }
  throw new Error("Explicit private HTTPS probe origin required");
}

const expectedAppOrigin = expectedProbeOrigin("KEEP_BETTER_AUTH_URL");
const expectedVaultOrigin = expectedProbeOrigin("KEEP_OPENCLOUD_URL");

const origin = expectedVaultOrigin;
const runId = process.env.VAULT_PROBE_RUN_ID ?? "";
const phase = process.env.VAULT_PROBE_PHASE ?? "";
const approvedSpace = "d3a176a6-2f2a-49fe-9ead-159902b4c48f$36b7656a-8f4c-4d30-8fdd-2934394b7102";
const token = process.env.QUANTSELF_OPENCLOUD_TOKEN;
const configuredSpace = process.env.QUANTSELF_OPENCLOUD_SPACE_ID;
const personal = process.env.VAULT_PROBE_PERSONAL_SPACE ?? "";
const fixture = "Synthetic Keep Vault permission proof " + runId + "\n";
const updated = fixture + "Updated by application identity.\n";
const output: Record<string, number> = {};
let step = "configuration";

function check(condition: unknown) {
  if (!condition) throw new Error("probe failed");
}

function path(space: string, name: string) {
  return origin + "/dav/spaces/" + encodeURIComponent(space) + "/" + name;
}

async function request(label: string, method: string, url: string, init: RequestInit = {}) {
  step = label;
  const response = await fetch(url, {
    ...init,
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {Authorization: "Basic " + Buffer.from("quantself:" + token).toString("base64"), ...init.headers},
  });
  output[label] = response.status;
  return response;
}

async function compare(response: Response, expected: string) {
  if (response.status !== 200 || !response.body) {
    await discard(response);
    throw new Error("Unexpected fixture response");
  }
  const bytes = Buffer.from(expected);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      check(offset + chunk.value.byteLength <= bytes.byteLength
        && Buffer.from(chunk.value).equals(bytes.subarray(offset, offset + chunk.value.byteLength)));
      offset += chunk.value.byteLength;
    }
    check(offset === bytes.byteLength);
  } finally {
    await reader.cancel();
  }
}

async function discard(response: Response) {
  await response.body?.cancel();
}

try {
  check(process.env.BETTER_AUTH_URL === expectedAppOrigin
    && process.env.QUANTSELF_OPENCLOUD_URL === origin
    && process.env.QUANTSELF_ORIGINALS_PROVIDER === "opencloud"
    && process.env.QUANTSELF_OPENCLOUD_USERNAME === "quantself"
    && process.env.QUANTSELF_INSTANCE_NAME === "Quantself Keep — private validation"
    && configuredSpace === approvedSpace && token);
  check(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(runId));
  check(["create", "confirm", "delete", "personal"].includes(phase));
  if (phase === "delete") check(process.env.VAULT_PROBE_APPROVED_DELETE === runId);
  const target = path(approvedSpace, "keep254-vault-probe-" + runId + ".txt");
  if (phase === "create") {
    const created = await request("originalsCreate", "PUT", target, {
      body: fixture, headers: {"Content-Type": "text/plain", "If-None-Match": "*"},
    });
    check(created.status === 201);
    await discard(created);
    const original = await request("originalsRead", "GET", target);
    await compare(original, fixture);
    const etag = original.headers.get("etag");
    check(etag && !etag.startsWith("W/"));
    const changed = await request("originalsUpdate", "PUT", target, {
      body: updated, headers: {"Content-Type": "text/plain", "If-Match": etag!},
    });
    check(changed.status === 200 || changed.status === 204);
    await discard(changed);
    await compare(await request("originalsReadUpdated", "GET", target), updated);
  } else if (phase === "confirm" || phase === "delete") {
    const current = await request("originalsReadUpdated", "GET", target);
    await compare(current, updated);
    if (phase === "delete") {
      const etag = current.headers.get("etag");
      check(etag && !etag.startsWith("W/"));
      const removed = await request("originalsDelete", "DELETE", target, {headers: {"If-Match": etag!}});
      check(removed.status === 204);
      await discard(removed);
      const missing = await request("originalsAbsent", "GET", target);
      check(missing.status === 404);
      await discard(missing);
    }
  } else {
    check(/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(personal)
      && personal !== approvedSpace);
    // Check that the installed credential still works on an owned known object.
    await compare(await request("originalsReadUpdated", "GET", target), updated);
    // Owner first creates and reads this known synthetic sentinel. Fetch headers
    // only for the evidence and discard the body even on unexpected success.
    const read = await request("personalRead", "GET", path(personal, "keep254-private-sentinel-" + runId + ".txt"));
    await discard(read);
    check(read.status === 403 || read.status === 404);
    const write = await request("personalWrite", "PUT", path(personal, "keep254-denied-write-" + runId + ".txt"), {
      body: fixture, headers: {"Content-Type": "text/plain", "If-None-Match": "*"},
    });
    await discard(write);
    check(write.status === 403 || write.status === 404);
  }
  console.log(JSON.stringify({phase, runId, result: "passed", checks: output}));
} catch {
  console.error(JSON.stringify({step, result: "failed", checks: output}));
  process.exitCode = 1;
}
