import { expect, test } from "bun:test";

test("dedicated App transport has bounded cold/warm requests and conditional payloads", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { githubHabitLoader } = await import("./habits-source");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const env = {
    QUANTSELF_HABITS_REPOSITORY: "fixture/habits",
    QUANTSELF_HABITS_GITHUB_APP_ID: "1",
    QUANTSELF_HABITS_GITHUB_INSTALLATION_ID: "2",
    QUANTSELF_HABITS_GITHUB_PRIVATE_KEY: key,
  };
  const requests: { path: string; init?: RequestInit }[] = [];
  let truncated = false;
  const transport = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, init });
    if (path === "/app/installations/2")
      return Response.json({
        app_id: 1,
        repository_selection: "selected",
        account: { login: "fixture" },
        suspended_at: null,
        permissions: { contents: "write" },
      });
    if (path.endsWith("access_tokens"))
      return Response.json({
        token: "synthetic",
        expires_at: "2099-01-01T00:00:00Z",
      });
    if (path === "/installation/repositories")
      return Response.json({
        total_count: 1,
        repositories: [{ full_name: "fixture/habits", private: true }],
      });
    if (path.endsWith("/git/trees/HEAD"))
      return Response.json({
        sha: "tree",
        truncated,
        tree: Array.from({ length: 125 }, (_, i) => ({
          type: "blob",
          path: `reviews/${new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)}.md`,
        })),
      });
    if ((init?.headers as Record<string, string>)["If-None-Match"])
      return new Response(null, { status: 304 });
    return Response.json(
      {
        sha: "a",
        encoding: "base64",
        size: 21,
        content: Buffer.from("stacks: []\nhabits: []").toString("base64"),
      },
      { headers: { etag: '"test"' } },
    );
  }) as typeof fetch;
  const load = githubHabitLoader(env, transport);
  const started = performance.now();
  await load(null);
  const cold = performance.now() - started;
  expect(requests).toHaveLength(4);
  expect(JSON.parse(String(requests[1].init?.body))).toEqual({
    repositories: ["habits"],
    permissions: { contents: "read", metadata: "read" },
  });
  const warmStart = performance.now();
  expect(await load("a")).toBeNull();
  const warm = performance.now() - warmStart;
  expect(requests).toHaveLength(5);
  console.info(
    `Habit mock transport: cold 4 requests ${cold.toFixed(2)}ms; warm 1 request ${warm.toFixed(2)}ms; cached interval 0 requests. No network latency simulated.`,
  );
  const { createHabitDocuments } = await import("./habits-documents");
  requests.length = 0;
  const documents = createHabitDocuments(githubHabitLoader(env, transport));
  const documentStart = performance.now();
  await Promise.all([
    documents.document("SYSTEM.md"),
    documents.document("playbook.md"),
  ]);
  const first = await documents.reviews();
  let page = first;
  let paths = [...first.paths];
  while (page.next !== null) {
    page = await documents.reviews(page.next);
    paths.push(...page.paths);
  }
  expect(paths).toHaveLength(125);
  expect(new Set(paths).size).toBe(125);
  expect(requests).toHaveLength(6); // one shared three-request auth setup, two bodies, one tree
  console.info(
    `Document transport: cold 6 requests for system+playbook+125-review index ${(performance.now() - documentStart).toFixed(2)}ms; all seven review pages share one tree.`,
  );
  const cachedStart = performance.now();
  await Promise.all([
    documents.document("SYSTEM.md"),
    documents.document("playbook.md"),
    documents.reviews(),
  ]);
  expect(requests).toHaveLength(6);
  console.info(
    `Document transport: warm 0 requests ${(performance.now() - cachedStart).toFixed(2)}ms; fixture only.`,
  );
  truncated = true;
  await expect(load(null, "reviews", true)).rejects.toThrow();
});

test("review create uses repository-scoped write token; concurrent creators and retries preserve answers", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { githubHabitLoader } = await import("./habits-source");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const env = {
    QUANTSELF_HABITS_REPOSITORY: "fixture/habits",
    QUANTSELF_HABITS_GITHUB_APP_ID: "1",
    QUANTSELF_HABITS_GITHUB_INSTALLATION_ID: "2",
    QUANTSELF_HABITS_GITHUB_PRIVATE_KEY: key,
  };
  let saved: string | null = null,
    writes = 0;
  const requests: { path: string; init?: RequestInit }[] = [];
  const transport = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, init });
    if (path === "/app/installations/2")
      return Response.json({
        app_id: 1,
        repository_selection: "selected",
        account: { login: "fixture" },
        suspended_at: null,
        permissions: { contents: "write" },
      });
    if (path.endsWith("access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repositories: ["habits"],
        permissions: { contents: "write", metadata: "read" },
      });
      return Response.json({
        token: "synthetic",
        expires_at: "2099-01-01T00:00:00Z",
      });
    }
    if (path === "/installation/repositories")
      return Response.json({
        total_count: 1,
        repositories: [{ full_name: "fixture/habits", private: true }],
      });
    if (path.endsWith("SYSTEM.md"))
      return Response.json({
        sha: "a",
        encoding: "base64",
        size: 21,
        content: Buffer.from("stacks: []\nhabits: []").toString("base64"),
      });
    if (init?.method === "PUT") {
      writes++;
      const body = JSON.parse(String(init.body));
      expect(body.sha).toBeUndefined();
      if (saved !== null) return Response.json({}, { status: 422 });
      saved = Buffer.from(body.content, "base64").toString();
      return Response.json({}, { status: 201 });
    }
    return saved === null
      ? Response.json({}, { status: 404 })
      : Response.json({
          sha: "existing",
          content: Buffer.from(saved).toString("base64"),
        });
  }) as typeof fetch;
  let writer = githubHabitLoader(env, transport, Date.now, "write");
  requests.length = 0;
  writer = githubHabitLoader(env, transport, Date.now, "write");
  const start = performance.now();
  await Promise.all([
    writer.createReview("reviews/2026-11-08.md", "first"),
    writer.createReview("reviews/2026-11-08.md", "second"),
  ]);
  expect(writes).toBe(2);
  expect(saved as string | null).toBe("first");
  saved = "Owner's answers";
  const before = requests.length,
    warmStart = performance.now();
  await writer.createReview("reviews/2026-11-08.md", "replacement");
  expect(saved).toBe("Owner's answers");
  expect(writes).toBe(2);
  expect(requests.length - before).toBe(2);
  console.info(
    `Review fixture: concurrent cold ${before} requests ${(warmStart - start).toFixed(2)}ms; warm reopen 2 requests ${(performance.now() - warmStart).toFixed(2)}ms; no network latency simulated.`,
  );
});
