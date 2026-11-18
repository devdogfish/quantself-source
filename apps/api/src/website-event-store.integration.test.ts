import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { websiteEventBatch } from "./website-event-contract";
import { websiteEventStore } from "./website-event-store";

test.skipIf(process.env.QUANTSELF_WEBSITE_DB_TEST !== "1")(
  "PostgreSQL deduplicates concurrent submissions and preserves the first event and inquiry",
  async () => {
    const { prisma } = await import("@quantself/db");
    const store = websiteEventStore();
    const redirectId = randomUUID();
    const events = websiteEventBatch.parse({
      events: [{
        id: redirectId, occurred_at: "2026-11-14T17:59:59Z", kind: "link:open",
        path: "/r/unknown-code/destination", link_code: "unknown-code", props: { method: "HEAD" },
      }, ...Array.from({ length: 49 }, () => ({
        id: randomUUID(), occurred_at: "2026-11-14T18:00:00Z", kind: "page:view",
        path: "/projects/example", session_id: randomUUID(), page_view_id: randomUUID(),
        visitor_id: randomUUID(), props: {},
      }))],
    }).events;
    const ids = events.map(({ id }) => id);
    const inquiry = {
      id: randomUUID(), name: "Test inquiry", email: "inquiry@example.test",
      topic: "Website project", message: "Synthetic private message", link_code: "unknown-code",
    };
    const tokenName = "QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN";
    const priorToken = process.env[tokenName];
    const token = "synthetic portfolio ingest token value";
    process.env[tokenName] = token;
    try {
      const { createApp } = await import("./app");
      const app = createApp({ emitAccessLog: () => {}, resolveAccessContext: async () => null });
      const headers = { "content-type": "application/json", "x-api-key": token };
      const eventPath = "/api/v1/website-analytics/events";
      // Warm the connection independently of the measured one-statement insert.
      await prisma.$queryRaw`SELECT 1`;
      const started = performance.now();
      const response = await app.request(eventPath, { method: "POST", headers, body: JSON.stringify({ events }) });
      console.log(`Website ingest: 50 PostgreSQL rows through the API in ${(performance.now() - started).toFixed(1)} ms`);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ received: 50, inserted: 50 });
      expect((await app.request("/api/v1/access-context", { headers })).status).toBe(401);

      const [first] = events;
      const retry = [{ ...first!, path: "/changed" }, ...events.slice(1)];
      expect(await Promise.all([store.insertEvents(retry), store.insertEvents(retry)])).toEqual([0, 0]);
      expect(await prisma.websiteEvent.count({ where: { id: { in: ids } } })).toBe(50);
      const stored = await prisma.websiteEvent.findUniqueOrThrow({ where: { id: redirectId } });
      expect(stored).toMatchObject({ path: "/r/unknown-code/destination", linkCode: "unknown-code",
        kind: "link:open", visitorId: null, props: { method: "HEAD" } });
      expect(stored.receivedAt).toBeInstanceOf(Date);

      await store.insertInquiry(inquiry);
      expect(await store.updateInquiryStatus(inquiry.id, "replied")).toBe(true);
      await store.insertInquiry({ ...inquiry, message: "Changed after retry" });
      expect(await prisma.websiteInquiry.findUniqueOrThrow({ where: { id: inquiry.id } }))
        .toMatchObject({ status: "replied", message: inquiry.message, linkCode: "unknown-code" });
      expect(await store.updateInquiryStatus(randomUUID(), "lost")).toBe(false);
    } finally {
      if (priorToken === undefined) delete process.env[tokenName];
      else process.env[tokenName] = priorToken;
      await prisma.websiteEvent.deleteMany({ where: { id: { in: ids } } });
      await prisma.websiteInquiry.deleteMany({ where: { id: inquiry.id } });
    }
  },
);
