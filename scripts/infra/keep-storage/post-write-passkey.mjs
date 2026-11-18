// Each invocation starts with a fresh browser context and a synthetic credential.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const [mode, webAddress, credentialPath, sessionPath, origin = "http://localhost:4310"] = process.argv.slice(2);
assert(["enroll", "restore"].includes(mode));
assert.match(webAddress, /^\d+\.\d+\.\d+\.\d+$/);
assert(["http://localhost:4310", "https://dashboard.girke.dev"].includes(origin));
const secure = origin.startsWith("https:");
const { hostname } = new URL(origin);
const sockets = new Set();
function forwardTcp(socket) {
  const upstream = createConnection({ host: webAddress, port: 3000 });
  socket.once("close", () => upstream.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
}

function forwardHttps(inbound, outbound) {
  if (inbound.headers.host !== hostname || !inbound.url.startsWith("/")) {
    outbound.writeHead(400).end();
    return;
  }
  const upstream = request({
    hostname: webAddress,
    port: 3000,
    method: inbound.method,
    path: inbound.url,
    headers: { ...inbound.headers, "x-forwarded-host": hostname, "x-forwarded-proto": "https",
      "x-forwarded-port": "443" },
  }, response => {
    outbound.writeHead(response.statusCode, response.headers);
    response.pipe(outbound);
  });
  outbound.on("close", () => upstream.destroy());
  upstream.on("error", () => outbound.destroy());
  inbound.pipe(upstream);
}

async function prepareTls(home) {
  const ca = join(home, "ca.crt");
  const cert = join(home, "server.crt");
  const key = join(home, "server.key");
  const csr = join(home, "server.csr");
  const extensions = join(home, "server.ext");
  const nss = join(home, ".pki", "nssdb");
  const openssl = args => execFileSync("openssl", args);
  openssl(["req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Synthetic rollback fixture CA", "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign", "-keyout", join(home, "ca.key"), "-out", ca]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + hostname,
    "-keyout", key, "-out", csr]);
  await writeFile(extensions, "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n"
    + "subjectAltName=DNS:" + hostname + "\n");
  openssl(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", join(home, "ca.key"),
    "-CAcreateserial", "-extfile", extensions, "-days", "1", "-out", cert]);
  await mkdir(nss, { recursive: true, mode: 0o700 });
  execFileSync("certutil", ["-N", "-d", "sql:" + nss, "--empty-password"]);
  execFileSync("certutil", ["-A", "-d", "sql:" + nss, "-n", "Rollback fixture CA", "-t", "C,,", "-i", ca]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

let bridge;
let browser;
let home;
try {
  if (secure) {
    home = await mkdtemp(join(dirname(sessionPath), "chrome-tls-"));
    bridge = createHttpsServer(await prepareTls(home), forwardHttps);
  } else {
    bridge = createServer(forwardTcp);
  }
  bridge.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(secure ? 443 : 4310, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    ...(secure && {
      env: { ...process.env, HOME: home },
      args: ["--no-proxy-server", "--disable-quic",
        "--host-resolver-rules=MAP " + hostname + " 127.0.0.1, MAP * ~NOTFOUND"],
    }),
  });
  const context = await browser.newContext();
  await context.route("**/*", r =>
    new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await context.newPage();
  const authResponses = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/owner-setup/passkey/") || path.startsWith("/api/auth/passkey/")) {
      authResponses.push(path + " " + response.status());
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  if (mode === "restore") {
    const credential = JSON.parse(await readFile(credentialPath, "utf8"));
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  }
  const entry = mode === "enroll" ? "/setup/owner" : "/login";
  const button = mode === "enroll" ? "Create owner passkey" : "Sign in with passkey";
  await page.goto(origin + entry, { waitUntil: "networkidle" });
  assert.deepEqual(await page.evaluate(() => [location.origin, isSecureContext]), [origin, true]);
  const accessContext = () => page.evaluate(async () => {
    const response = await fetch("/api/v1/access-context");
    return { status: response.status, access: await response.json() };
  });
  if (mode === "restore") assert.equal((await accessContext()).status, 401);
  const verifyPath = mode === "enroll" ? "/api/owner-setup/passkey/verify" : "/api/auth/passkey/verify-authentication";
  try {
    const [verified] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === verifyPath, { timeout: 15_000 }),
      page.getByRole("button", { name: button, exact: true }).click(),
    ]);
    const outcome = verified.ok() ? "ok" : (await verified.json().catch(() => ({}))).code;
    assert.equal(verified.status(), 200, `Passkey verification failed with ${outcome ?? "unknown"}`);
  } catch (error) {
    console.error("Auth response statuses:", authResponses.join(", "));
    console.error("Passkey UI:", await page.locator("[aria-live=polite]").first().textContent({ timeout: 2_000 }).catch(() => ""));
    throw error;
  }
  const { status, access } = await accessContext();
  assert.equal(status, 200);
  assert.equal(access.client.kind, "web");
  assert.ok(access.owner.id);
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].rpId, hostname);
  if (mode === "enroll") {
    await writeFile(credentialPath, JSON.stringify(credentials[0]), { mode: 0o600, flag: "wx" });
  }
  const cookies = await context.cookies(origin);
  const cookie = cookies.map(({ name, value }) => name + "=" + value).join("; ");
  assert.ok(cookie.includes("session_token="));
  await writeFile(sessionPath, JSON.stringify({ ownerId: access.owner.id, cookie }), {
    mode: 0o600, flag: "wx",
  });
  console.log("PASS fresh browser " + mode + " through the actual passkey UI at " + origin);
} finally {
  if (browser) await browser.close();
  for (const socket of sockets) socket.destroy();
  if (bridge?.listening) await new Promise(resolve => bridge.close(resolve));
  if (home) await rm(home, { recursive: true, force: true });
}
