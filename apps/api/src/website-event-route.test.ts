import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { websiteAnalyticsMaxBytes, type WebsiteEvent, type WebsiteInquiryInput } from "./website-event-contract";
import { registerWebsiteAnalyticsIngestRoutes, registerWebsiteInquiryStatusRoute } from "./website-event-route";
import type { WebsiteEventStore } from "./website-event-store";

const origin = new URL(process.env.BETTER_AUTH_URL ?? "https://portfolio-api.example.test").origin;
const root = `${origin}/api/v1/website-analytics`;
const token = "synthetic portfolio ingest token value";
const owner = { id: "owner", name: "Owner", email: "owner@example.test" };
const browserIds = {
  visitor_id: "10000000-0000-4000-8000-000000000002",
  session_id: "10000000-0000-4000-8000-000000000003",
  page_view_id: "10000000-0000-4000-8000-000000000004",
};
const linkOpen = {
  id: "10000000-0000-4000-8000-000000000005",
  occurred_at: "2026-11-14T17:59:59Z",
  kind: "link:open",
  path: "/r/unknown-code/destination",
  link_code: "unknown-code",
  ip_id: "a".repeat(64),
  props: { method: "HEAD", key: "destination", ua: "Synthetic browser" },
} as const;
const inquiry = {
  id: "10000000-0000-4000-8000-000000000006",
  name: "Example Person",
  email: "inquiry@example.test",
  topic: "Website project",
  message: "A private inquiry.",
  link_code: "unknown-code",
};

function fixture(configuredToken: string | null = token) {
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  const events: WebsiteEvent[][] = [];
  const inquiries: WebsiteInquiryInput[] = [];
  const updates: Parameters<WebsiteEventStore["updateInquiryStatus"]>[] = [];
  const store: WebsiteEventStore = {
    insertEvents: async batch => { events.push(batch); return batch.length; },
    insertInquiry: async input => { inquiries.push(input); },
    updateInquiryStatus: async (...args) => { updates.push(args); return args[0] === inquiry.id; },
  };
  registerWebsiteAnalyticsIngestRoutes(app, store, () => configuredToken ?? undefined);
  app.use("*", async (context, next) => {
    const auth = context.req.header("x-api-key") === "synthetic-ordinary-key" ? "api-key"
      : context.req.header("cookie") === "session=owner" ? "web" : null;
    context.set("accessContext", auth ? { client: { id: auth, name: auth, kind: auth }, owner, permissions: [] } : null);
    await next();
  });
  app.get("/settings", context => context.body(null, context.get("accessContext") ? 204 : 401));
  registerWebsiteInquiryStatusRoute(app, store);
  function json(path: string, value: unknown, headers: Record<string, string> = {}, method = "POST") {
    return app.request(root + path, {
      method,
      body: JSON.stringify(value),
      headers: { "content-type": "application/json", "x-api-key": token, ...headers },
    });
  }
  return { app, events, inquiries, updates, json };
}

test("GET and HEAD redirect opens with unknown via codes are accepted in a single store call", async () => {
  const f = fixture();
  const events: WebsiteEvent[] = [
    linkOpen,
    { ...linkOpen, id: inquiry.id, props: { ...linkOpen.props, method: "GET" } },
    {
      ...browserIds, id: "10000000-0000-4000-8000-000000000001",
      occurred_at: linkOpen.occurred_at, kind: "page:engagement",
      path: "/projects/rbc", device: "mobile", link_code: "unknown-code",
      props: { activeMs: 5000, maxScroll: 83.5 },
    },
  ];
  const response = await f.json("/events", { events });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ received: 3, inserted: 3 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(f.events).toEqual([events]);
});

test("ingest rejects raw identifiers, unexpected props, oversized or invalid batches before persistence", async () => {
  const f = fixture();
  for (const events of [
    [],
    Array.from({ length: 51 }, () => linkOpen),
    [{ ...linkOpen, kind: "page:view", props: {} }],
    [{ ...linkOpen, ip_id: "192.0.2.1" }],
    [{ ...linkOpen, path: "/contact?email=inquiry@example.test" }],
    [{ ...linkOpen, props: { ...linkOpen.props, email: "inquiry@example.test" } }],
  ]) {
    expect((await f.json("/events", { events })).status).toBe(400);
  }
  const body = JSON.stringify({ events: [linkOpen] }).padEnd(websiteAnalyticsMaxBytes + 1);
  for (const length of [{}, { "content-length": String(body.length) }]) {
    const response = await f.app.request(root + "/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token, ...length } as Record<string, string>,
      body,
    });
    expect(response.status).toBe(413);
  }
  expect(f.events).toHaveLength(0);
});

test("dedicated key only grants the two ingest posts, while same-origin Owner can update inquiry status", async () => {
  const f = fixture();
  for (const path of ["/events", "/inquiries"]) {
    expect((await f.json(path, {}, { "x-api-key": "synthetic-ordinary-key" })).status).toBe(401);
    expect((await f.json(path, {}, { "x-api-key": "", cookie: "session=owner" })).status).toBe(401);
    expect((await fixture(null).json(path, {})).status).toBe(503);
  }
  const accepted = await f.json("/inquiries", inquiry);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ id: inquiry.id });
  expect((await f.json("/inquiries", { ...inquiry, visitor_id: browserIds.visitor_id })).status).toBe(400);
  expect(f.inquiries).toEqual([inquiry]);
  expect((await f.app.request(origin + "/settings", { headers: { "x-api-key": token } })).status).toBe(401);
  const path = "/inquiries/" + inquiry.id;
  const status = { status: "replied" };
  expect((await f.json(path, status, { origin }, "PATCH")).status).toBe(401);
  expect((await f.json(path, status, { origin, "x-api-key": "synthetic-ordinary-key" }, "PATCH")).status).toBe(403);
  const headers = { cookie: "session=owner", "x-api-key": "" };
  expect((await f.json(path, status, { ...headers, origin: "https://foreign.test" }, "PATCH")).status).toBe(403);
  expect((await f.json(path, status, { ...headers, origin }, "PATCH")).status).toBe(200);
  expect(f.updates).toEqual([[inquiry.id, "replied"]]);
});
