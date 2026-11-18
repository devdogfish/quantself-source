import { expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { AccessContext } from "@quantself/auth";
import sharp from "sharp";

function pdf(content: string, resources: string, extra: Buffer[]) {
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents 4 0 R >>`),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
    ...extra,
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = ["0000000000 65535 f \n"];
  let position = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(position).padStart(10, "0")} 00000 n \n`);
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(entry);
    position += entry.length;
  }
  parts.push(Buffer.from(`xref\n0 ${offsets.length}\n${offsets.join("")}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function textReceipt(merchant: string, total: string) {
  const lines = [merchant, "2026-10-28", `Total CAD ${total}`];
  const content = `BT /F1 26 Tf 36 TL 72 690 Td ${lines.map(line => `(${line}) Tj T*`).join(" ")} ET`;
  return pdf(content, "<< /Font << /F1 5 0 R >> >>", [
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
}

async function poppler(command: string[], input: Buffer) {
  const child = Bun.spawn(command, { stdin: new Blob([new Uint8Array(input)]), stdout: "pipe", stderr: "inherit", timeout: 10_000 });
  const [data, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  expect(code).toBe(0);
  return new Uint8Array(data);
}

async function imageReceipt() {
  const png = await poppler(["pdftoppm", "-png", "-r", "150", "-singlefile", "-"], textReceipt("Orchid Test Station", "29.64"));
  const { data, info: { width, height } } = await sharp(png).toColourspace("srgb").jpeg().toBuffer({ resolveWithObject: true });
  const jpeg = Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`),
    data, Buffer.from("\nendstream"),
  ]);
  return pdf("q 612 0 0 792 0 0 cm /I1 Do Q", "<< /XObject << /I1 5 0 R >> >>", [jpeg]);
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const vault = "https://127.0.0.1:19200";

async function prepareOpenCloud() {
  const password = process.env.IDM_ADMIN_PASSWORD;
  if (!password) throw new Error("Missing disposable OpenCloud bootstrap password.");
  const authorization = "Basic " + Buffer.from("admin:" + password).toString("base64");
  const headers = { Authorization: authorization, "Content-Type": "application/json" };
  const deadline = performance.now() + 30_000;
  while (true) {
    const response = await fetch(vault + "/graph/v1.0/me/drives", { headers, signal: AbortSignal.timeout(750) }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) break;
    if (performance.now() >= deadline) throw new Error("Disposable OpenCloud did not become ready.");
    await Bun.sleep(250);
  }
  const project = await fetch(vault + "/graph/v1.0/drives", { method: "POST", headers,
    body: JSON.stringify({ name: "Synthetic OCR originals", driveType: "project", quota: { total: 10_000_000 } }),
  });
  expect(project.status).toBe(201);
  const { id: spaceId } = await project.json() as { id: string };
  expect(spaceId).toBeTruthy();
  const appName = "synthetic-ocr-app";
  const appPassword = randomUUID();
  const appUser = await fetch(vault + "/graph/v1.0/users", { method: "POST", headers, body: JSON.stringify({
    displayName: "Synthetic OCR app", onPremisesSamAccountName: appName, mail: "ocr-app@example.invalid",
    passwordProfile: { password: appPassword },
  }) });
  expect(appUser.status).toBe(201);
  const { id: appId } = await appUser.json() as { id: string };
  const root = vault + "/graph/v1beta1/drives/" + encodeURIComponent(spaceId) + "/root";
  const permissions = await fetch(root + "/permissions", { headers });
  expect(permissions.ok).toBe(true);
  const roles = (await permissions.json() as {
    "@libre.graph.permissions.roles.allowedValues": { id: string; displayName: string }[];
  })["@libre.graph.permissions.roles.allowedValues"];
  const editorRole = roles.find(role => role.displayName === "Can edit");
  expect(editorRole).toBeDefined();
  const invite = await fetch(root + "/invite", { method: "POST", headers, body: JSON.stringify({
    recipients: [{ objectId: appId, "@libre.graph.recipient.type": "user" }], roles: [editorRole!.id],
  }) });
  expect(invite.status).toBe(200);
  const appAuthorization = "Basic " + Buffer.from(appName + ":" + appPassword).toString("base64");
  const issued = await fetch(vault + "/auth-app/tokens?expiry=1h&label=ocr-fixture", {
    method: "POST", headers: { Authorization: appAuthorization },
  });
  expect(issued.ok).toBe(true);
  const { token } = await issued.json() as { token: string };
  expect(Boolean(token)).toBe(true);
  Object.assign(process.env, { QUANTSELF_OPENCLOUD_URL: vault, QUANTSELF_OPENCLOUD_SPACE_ID: spaceId,
    QUANTSELF_OPENCLOUD_USERNAME: appName, QUANTSELF_OPENCLOUD_TOKEN: token });
}

const oneDocument = process.env.QUANTSELF_PRIVATE_OCR_ONE_DOCUMENT === "1";

test.skipIf(process.env.QUANTSELF_PRIVATE_OCR_DOCKER !== "1" || oneDocument)(
  "Owner capture, expired OCR claim recovery, reveal, dedupe and failed original in disconnected Docker",
  async () => {
    const dbUrl = new URL(process.env.DATABASE_URL ?? "");
    if (process.platform !== "linux" || dbUrl.protocol !== "postgresql:" || dbUrl.hostname !== "127.0.0.1" ||
        dbUrl.pathname !== "/private_ocr_fixture" || process.env.GIRKE_API_BASE_URL || process.env.GIRKE_API_TOKEN) {
      throw new Error("Use the disconnected private OCR Docker fixture.");
    }
    const openCloud = process.env.QUANTSELF_ORIGINALS_PROVIDER === "opencloud";
    if (openCloud) await prepareOpenCloud();
    const [{ createApp }, { processPrivateDocument, startPrivateDocumentWorker }, { prisma }, { referenceKey }, { extractBudgetDocument }] = await Promise.all([
      import("./app"), import("./private-document-worker"), import("@quantself/db"), import("./original-files"), import("./budget-document-scan"),
    ]);
    const owner = { id: "synthetic-private-ocr", email: "fixture@example.test", name: "Fixture" };
    const permissions: AccessContext["permissions"] = ["budgeting:read", "budgeting:write"];
    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async (headers): Promise<AccessContext> => ({
        owner, permissions, client: { id: "fixture", name: "Fixture", kind: headers.has("x-fixture-api-key") ? "api-key" : "web" },
      }),
    });
    const origin = "http://127.0.0.1:3000";
    const path = "/api/v1/budgeting/receipts";
    let requests = 0;
    const request = (route: string, { apiKey, ...init }: RequestInit & { apiKey?: boolean } = {}) => {
      requests += 1;
      return app.request(origin + route, { ...init, headers: { Origin: origin, ...(apiKey && { "x-fixture-api-key": "fixture" }) } });
    };
    const upload = (data: Buffer, id = randomUUID(), apiKey = false) => {
      const body = new FormData();
      body.set("id", id);
      body.set("kind", "receipt");
      body.set("photo", new File([new Uint8Array(data)], "fixture.pdf", { type: "application/pdf" }));
      return request(path, { method: "POST", body, apiKey });
    };
    const cases = [
      { merchant: "Orchid Test Station", totalCents: 2964, bytes: await imageReceipt() },
      { merchant: "Cedar Test Studio", totalCents: 1872, bytes: textReceipt("Cedar Test Studio", "18.72") },
    ];
    const malformed = Buffer.from("%PDF-1.4\nFictional deliberately malformed PDF\n");
    const textCommand = ["pdftotext", "-layout", "-", "-"];
    const decode = (data: Uint8Array) => new TextDecoder().decode(data).trim();
    expect(decode(await poppler(textCommand, cases[0].bytes))).toBe("");
    expect(decode(await poppler(textCommand, cases[1].bytes))).toContain(cases[1].merchant);

    async function proveExpiredClaim(id: string, receipt: (typeof cases)[number]) {
      const snapshot = () => prisma.budgetReceipt.findUniqueOrThrow({
        where: { ownerId_id: { ownerId: owner.id, id } },
        select: { imageHash: true, originalKey: true, scanStatus: true, scanProvenance: true,
          scanLeaseId: true, scanLeaseUntil: true, merchant: true, totalCents: true },
      });
      const before = await snapshot();
      const readOriginal = () => before.originalKey
        ? prisma.originalFile.findUniqueOrThrow({ where: { key: referenceKey(before.originalKey) } })
        : null;
      const original = await readOriginal();
      const attempts = await prisma.originalUploadAttempt.count();
      const methods: string[] = [];
      const forward = globalThis.fetch;
      const observe = spyOn(globalThis, "fetch").mockImplementation(new Proxy(forward, {
        apply(target, receiver, args: Parameters<typeof forward>) {
          const [input, init] = args;
          if (typeof input === "string" && input.startsWith(vault + "/dav/spaces/")) {
            methods.push(init?.method ?? "GET");
          }
          return Reflect.apply(target, receiver, args);
        },
      }));
      const expectedDigest = digest(receipt.bytes);
      const firstRead = Promise.withResolvers<string>();
      const secondRead = Promise.withResolvers<string>();
      const finishFirst = Promise.withResolvers<void>();
      const finishSecond = Promise.withResolvers<void>();
      const reachedOriginal = (read: Promise<string>, worker: Promise<boolean>) => Promise.race([
        read, worker.then(() => { throw new Error("Worker finished before fetching the fixture original."); }),
      ]);
      // Move the worker clock across the persisted deadline without editing the row or waiting ten minutes.
      let now = new Date();
      const clock = () => now;
      const firstWorker = processPrivateDocument(prisma, async image => {
        firstRead.resolve(digest(image));
        await finishFirst.promise;
        return { merchant: "Fictional stale result", date: null, totalCents: 12345, lines: [] };
      }, clock);
      let secondWorker: Promise<boolean> | undefined;
      try {
        expect(await reachedOriginal(firstRead.promise, firstWorker)).toBe(expectedDigest);
        const claimed = await snapshot();
        expect(claimed).toMatchObject({ scanStatus: "processing", scanProvenance: null, originalKey: before.originalKey });
        if (!claimed.scanLeaseUntil || !claimed.scanLeaseId) throw new Error("Expected a durable worker claim.");
        now = new Date(claimed.scanLeaseUntil.getTime() - 1);
        expect(await processPrivateDocument(prisma, undefined, clock)).toBe(false);
        expect(await snapshot()).toEqual(claimed);

        now = claimed.scanLeaseUntil;
        secondWorker = processPrivateDocument(prisma, async (...args) => {
          secondRead.resolve(digest(args[0]));
          await finishSecond.promise;
          return extractBudgetDocument(...args);
        }, clock);
        expect(await reachedOriginal(secondRead.promise, secondWorker)).toBe(expectedDigest);
        const replaced = await snapshot();
        expect(replaced).toMatchObject({ scanStatus: "processing", scanProvenance: null, originalKey: before.originalKey });
        expect(replaced.scanLeaseId).toBeTruthy();
        expect(replaced.scanLeaseId).not.toBe(claimed.scanLeaseId);
        expect(replaced.scanLeaseUntil!.getTime()).toBeGreaterThan(now.getTime());

        const replay = await upload(receipt.bytes);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ id, scanStatus: "processing", scanProvenance: null });
        finishFirst.resolve();
        expect(await firstWorker).toBe(true);
        expect(await snapshot()).toEqual(replaced);
        finishSecond.resolve();
        expect(await secondWorker).toBe(true);
        expect(await snapshot()).toEqual({ ...before, scanStatus: "archived", scanProvenance: "ocr_completed",
          merchant: receipt.merchant, totalCents: receipt.totalCents });
        expect(await readOriginal()).toEqual(original);
        expect(await prisma.originalUploadAttempt.count()).toBe(attempts);
        expect(methods).toEqual(openCloud ? ["GET", "GET"] : []);
      } finally {
        finishFirst.resolve();
        finishSecond.resolve();
        await Promise.allSettled([firstWorker, secondWorker]);
        observe.mockRestore();
      }
    }

    let stop: (() => Promise<void>) | undefined;
    try {
      const captured: string[] = [];
      let uploadMs = 0;
      for (const bytes of [...cases.map(item => item.bytes), malformed]) {
        const uploadStarted = performance.now();
        const accepted = await upload(bytes);
        expect(accepted.status).toBe(200);
        const row = await accepted.json() as { id: string };
        expect(accepted.headers.get("cache-control")).toBe("no-store");
        expect(row).toMatchObject({ scanStatus: "pending", scanProvenance: null, merchant: "", lines: [] });
        const saved = await prisma.budgetReceipt.findUniqueOrThrow({
          where: { ownerId_id: { ownerId: owner.id, id: row.id } }, select: { imageHash: true, image: true, originalKey: true },
        });
        expect(saved.imageHash).toBe(digest(bytes));
        if (openCloud) {
          expect(saved.image).toBeNull();
          expect(saved.originalKey).toBeTruthy();
          const original = await prisma.originalFile.findUniqueOrThrow({ where: { key: referenceKey(saved.originalKey!) } });
          expect(original).toMatchObject({ state: "ready", sha256: digest(bytes), bytes: bytes.length,
            spaceId: process.env.QUANTSELF_OPENCLOUD_SPACE_ID });
          expect(original.fileId).toBeTruthy();
          const response = await fetch(vault + "/dav/spaces/" + encodeURIComponent(original.fileId!), { redirect: "manual" });
          expect([401, 403, 404]).toContain(response.status);
          await response.body?.cancel();
        } else {
          expect(saved.originalKey).toBeNull();
          expect(saved.image && digest(saved.image)).toBe(digest(bytes));
        }
        captured.push(row.id);
        uploadMs += performance.now() - uploadStarted;
        if (captured.length === 1) await proveExpiredClaim(row.id, cases[0]);
      }
      const queueStarted = performance.now();
      stop = startPrivateDocumentWorker();
      const statuses = new Map<string, string>();
      do {
        const rows = await prisma.budgetReceipt.findMany({
          where: { ownerId: owner.id }, select: { id: true, scanStatus: true },
        });
        for (const row of rows) statuses.set(row.id, row.scanStatus);
        if (statuses.size === 3 && [...statuses.values()].every(status => status === "archived" || status === "failed")) break;
        await Bun.sleep(75);
      } while (performance.now() - queueStarted < 30_000);
      expect(captured.map(id => statuses.get(id))).toEqual(["archived", "archived", "failed"]);
      const queueMs = Math.round(performance.now() - queueStarted);
      const uploadAttempts = await prisma.originalUploadAttempt.count();

      for (const [index, item] of cases.entries()) {
        const route = `${path}/${captured[index]}`;
        const concealed = await request(route);
        expect(concealed.status).toBe(200);
        expect(await concealed.json()).toMatchObject({ scanStatus: "archived", scanProvenance: "ocr_completed",
          merchant: "", date: null, totalCents: null, lines: [] });
        const revealed = await request(route + "?reveal=yes");
        expect(revealed.status).toBe(200);
        expect(revealed.headers.get("cache-control")).toBe("no-store");
        expect(await revealed.json()).toMatchObject({ scanStatus: "archived", scanProvenance: "ocr_completed",
          merchant: item.merchant, date: "2026-10-28", totalCents: item.totalCents, currency: "CAD" });
        const original = await request(route + "/original");
        expect(original.status).toBe(200);
        expect(digest(new Uint8Array(await original.arrayBuffer()))).toBe(digest(item.bytes));
        // Replay after losing the first upload response with a new client-generated ID.
        const replay = await upload(item.bytes);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ id: captured[index], scanStatus: "archived", scanProvenance: "ocr_completed", merchant: "" });
      }
      const stored = await prisma.budgetReceipt.findMany({
        where: { ownerId: owner.id }, select: { id: true, imageHash: true, scanLeaseId: true, scanLeaseUntil: true },
      });
      expect(stored).toHaveLength(3);
      expect(await prisma.originalFile.count()).toBe(openCloud ? 3 : 0);
      expect(await prisma.originalUploadAttempt.count()).toBe(uploadAttempts);
      for (const [index, bytes] of [...cases.map(item => item.bytes), malformed].entries()) {
        expect(stored.find(row => row.id === captured[index])).toEqual({
          id: captured[index], imageHash: digest(bytes), scanLeaseId: null, scanLeaseUntil: null,
        });
      }

      const failed = `${path}/${captured[2]}`;
      const failedDetail = await request(failed + "?reveal=yes");
      expect(failedDetail.status).toBe(200);
      expect(await failedDetail.json()).toMatchObject({ scanStatus: "failed", scanProvenance: null, merchant: "", lines: [] });
      const retained = await request(failed + "/original");
      expect(retained.status).toBe(200);
      expect(digest(new Uint8Array(await retained.arrayBuffer()))).toBe(digest(malformed));

      for (const route of [path, path + "?reveal=yes", failed + "?reveal=yes", failed + "/original", `${path}/${captured[1]}?reveal=yes`]) {
        expect((await request(route, { apiKey: true })).status).toBe(403);
      }
      expect((await request(failed + "/scan", { method: "POST", apiKey: true })).status).toBe(403);
      expect((await upload(malformed, undefined, true)).status).toBe(403);
      console.log("Private OCR fixture", JSON.stringify({ storage: openCloud ? "opencloud" : "legacy",
        requests, uploadMs: Math.round(uploadMs), queueMs, storedOriginals: stored.length,
        expiredClaimRecovered: true, staleWriteRejected: true, externalNetwork: false }));
    } finally {
      await stop?.();
      await prisma.$disconnect();
    }
  },
  60_000,
);

test.skipIf(process.env.QUANTSELF_PRIVATE_OCR_DOCKER !== "1" || !oneDocument)(
  "one synthetic document through Owner capture, active local OCR, reveal and cleanup",
  async () => {
    const dbUrl = new URL(process.env.DATABASE_URL ?? "");
    if (process.platform !== "linux" || Object.keys(networkInterfaces()).join() !== "lo" ||
        dbUrl.protocol !== "postgresql:" || dbUrl.hostname !== "127.0.0.1" || !dbUrl.port ||
        dbUrl.pathname !== "/private_ocr_fixture" || process.env.GIRKE_API_BASE_URL || process.env.GIRKE_API_TOKEN) {
      throw new Error("Use the disconnected private OCR Docker fixture.");
    }
    const openCloud = process.env.QUANTSELF_ORIGINALS_PROVIDER === "opencloud";
    const origin = "http://127.0.0.1:3000";
    const proof = "4a".repeat(32);
    const previousProof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
    const owner = { id: "synthetic-single-ocr", email: "fixture@example.test", name: "Fixture" };
    const allowedOrigins = new Set(openCloud ? [vault] : []);
    const upstream = globalThis.fetch;
    let externalRequests = 0;
    const observe = spyOn(globalThis, "fetch").mockImplementation(new Proxy(upstream, {
      apply(target, receiver, args: Parameters<typeof upstream>) {
        const input = args[0];
        if (!allowedOrigins.has(new URL(input instanceof Request ? input.url : input).origin)) {
          externalRequests++;
          throw new Error("Unexpected fixture network destination.");
        }
        return Reflect.apply(target, receiver, args);
      },
    }));
    let api: ReturnType<typeof Bun.serve> | undefined;
    let stopWorker: (() => Promise<void>) | undefined;
    let stopCleanup: (() => void) | undefined;
    let disconnect: (() => Promise<void>) | undefined;
    let requests = 0, polls = 0;
    async function waitFor(check: () => Promise<boolean>, message: string) {
      const deadline = performance.now() + 15_000;
      do {
        if (await check()) return;
        await Bun.sleep(250);
      } while (performance.now() < deadline);
      throw new Error(message);
    }

    try {
      if (openCloud) await prepareOpenCloud();
      const [{ createApp }, { createAgentApiKey }, { OWNER_INGRESS_HEADER }, { prisma }, { startPrivateDocumentWorker },
        { referenceKey }, { startOriginalFilesWorker }, { openCloudFromEnvironment }] = await Promise.all([
        import("./app"), import("@quantself/auth"), import("@quantself/auth/owner-ingress"), import("@quantself/db"),
        import("./private-document-worker"), import("./original-files"), import("./original-files-worker"), import("./original-storage"),
      ]);
      disconnect = () => prisma.$disconnect();
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const { secret } = await createAgentApiKey({
        userId: owner.id, name: "Synthetic OCR scope probe", permissionIds: ["budgeting:read"],
      });
      api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp({ emitAccessLog() {} }).fetch });
      const apiOrigin = api.url.origin;
      allowedOrigins.add(apiOrigin);
      const request = (path: string, init: RequestInit = {}, agent = false) => {
        requests++;
        return fetch(apiOrigin + path, {
          ...init, redirect: "error", signal: AbortSignal.timeout(5000),
          headers: { Origin: origin, ...(agent ? { "x-api-key": secret } : { [OWNER_INGRESS_HEADER]: proof }) },
        });
      };
      const path = "/api/v1/budgeting/receipts";
      const bytes = await imageReceipt();
      const sha256 = digest(bytes);
      expect(new TextDecoder().decode(await poppler(["pdftotext", "-", "-"], bytes)).trim()).toBe("");
      const id = randomUUID();
      const detail = path + "/" + id;
      const makeUpload = (receiptId: string) => {
        const body = new FormData();
        body.set("id", receiptId);
        body.set("kind", "receipt");
        body.set("photo", new File([new Uint8Array(bytes)], "synthetic-ocr.pdf", { type: "application/pdf" }));
        return request(path, { method: "POST", body });
      };

      stopWorker = startPrivateDocumentWorker();
      const started = performance.now();
      const accepted = await makeUpload(id);
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("cache-control")).toBe("no-store");
      expect(await accepted.json()).toMatchObject({ id, scanStatus: "pending", scanProvenance: null, merchant: "", lines: [] });
      const captureMs = Math.round(performance.now() - started);
      await waitFor(async () => {
        polls++;
        const response = await request(detail);
        expect(response.status).toBe(200);
        const body = await response.json() as { scanStatus: string; scanProvenance: string | null };
        expect(body).toMatchObject({ id, merchant: "", date: null, totalCents: null, lines: [] });
        if (body.scanStatus === "failed") throw new Error("Fixture scan failed.");
        return body.scanStatus === "archived" && body.scanProvenance === "ocr_completed";
      }, "Active worker did not complete the same receipt.");
      const completedMs = Math.round(performance.now() - started);

      const revealed = await request(detail + "?reveal=yes");
      expect(revealed.status).toBe(200);
      expect(revealed.headers.get("cache-control")).toBe("no-store");
      expect(await revealed.json()).toMatchObject({
        id, merchant: "Orchid Test Station", date: "2026-10-28", totalCents: 2964, scanProvenance: "ocr_completed",
      });
      const original = await request(detail + "/original");
      expect(original.status).toBe(200);
      expect(digest(new Uint8Array(await original.arrayBuffer()))).toBe(sha256);
      for (const route of [detail + "?reveal=yes", detail + "/original"]) {
        const denied = await request(route, {}, true);
        expect(denied.status).toBe(403);
        await denied.body?.cancel();
      }
      const replay = await makeUpload(randomUUID());
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id, scanStatus: "archived", merchant: "" });
      expect(await prisma.budgetReceipt.count({ where: { ownerId: owner.id } })).toBe(1);
      const stored = await prisma.budgetReceipt.findUniqueOrThrow({ where: { ownerId_id: { ownerId: owner.id, id } } });
      expect(stored.imageHash).toBe(sha256);
      if (openCloud) {
        expect(stored.originalKey).toBeTruthy();
        expect(stored.image).toBeNull();
        expect(await prisma.originalFile.count()).toBe(1);
      }

      const cleaning = performance.now();
      const deleted = await request(detail, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
      for (const route of [detail, detail + "/original"]) {
        const absent = await request(route);
        expect(absent.status).toBe(404);
        await absent.body?.cancel();
      }
      expect(await prisma.budgetReceipt.count({ where: { ownerId: owner.id } })).toBe(0);
      if (stored.originalKey) {
        const where = { key: referenceKey(stored.originalKey) };
        const ledger = () => prisma.originalFile.findUniqueOrThrow({ where });
        const queued = await ledger();
        expect(queued).toMatchObject({ state: "deleting", sha256 });
        stopCleanup = startOriginalFilesWorker();
        await waitFor(async () => (await ledger()).state === "deleted", "Original cleanup did not finish.");
        expect(await openCloudFromEnvironment().inspect(queued.pathHint)).toBeNull();
      }
      expect(externalRequests).toBe(0);
      console.log("Private OCR one-document fixture", JSON.stringify({
        storage: openCloud ? "opencloud" : "legacy", id, sha256, captureMs, completedMs,
        cleanupMs: Math.round(performance.now() - cleaning), requests, polls, externalRequests,
      }));
    } finally {
      await Promise.all([stopWorker?.(), stopCleanup?.()]);
      api?.stop(true);
      await disconnect?.();
      observe.mockRestore();
      if (previousProof === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = previousProof;
    }
  },
  45_000,
);
