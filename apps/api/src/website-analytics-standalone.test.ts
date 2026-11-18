import { expect, test } from "bun:test";

test("relay drains an admitted collector request before shutdown", async () => {
  const token = "backup-drain-test-token-with-32-bytes";
  const { promise: admitted, resolve: admit } = Promise.withResolvers<void>();
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      admit();
      await pending;
      return Response.json({ processed: 1, errors: 0 });
    },
  });
  const relay = Bun.spawn(["bun", "src/website-analytics-standalone.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: {
      ...process.env,
      API_HOSTNAME: "127.0.0.1",
      API_PORT: "0",
      QUANTSELF_UMAMI_URL: upstream.url.origin,
      QUANTSELF_UMAMI_WEBSITE_ID: crypto.randomUUID(),
      QUANTSELF_WEBSITE_ANALYTICS_TOKEN: token,
    },
    stdout: "pipe",
  });

  const logs = relay.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let request: Promise<Response> | undefined;
  try {
    const started = await logs.read();
    const origin = started.value?.match(/Analytics relay listening on (http:\/\/127[.]0[.]0[.]1:[0-9]+)/)?.[1];
    if (!origin) throw Error("The fixture relay failed to start.");
    request = fetch(new URL("/api/v1/website-analytics/events", origin), {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ events: [{
        eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
        pageViewId: crypto.randomUUID(), seq: 1, occurredAt: new Date().toISOString(),
        cohort: "software", path: "/", type: "page_view", properties: {},
      }] }),
    });
    await Promise.race([admitted, request.then(response => {
      throw Error(`Fixture forwarding did not run: status ${response.status}`);
    })]);
    relay.kill("SIGTERM");
    await Bun.sleep(25);
    expect(relay.exitCode).toBeNull();
    release();
    expect((await request).status).toBe(200);
    expect(await relay.exited).toBe(0);
    expect((await logs.read()).value).toContain("Analytics relay drain complete");
  } finally {
    release();
    void request?.catch(() => {});
    relay.kill("SIGKILL");
    await upstream.stop(true);
  }
}, 5_000);
