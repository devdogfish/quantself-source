import { randomUUID } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import { toUmamiEvent, websiteAnalyticsIngestion } from "./website-analytics-route";

const token = "t".repeat(48);
const now = Date.parse("2026-11-10T14:00:00Z");
const event = {
  eventId: randomUUID(), visitorId: randomUUID(), sessionId: randomUUID(), pageViewId: randomUUID(),
  seq: 1, occurredAt: new Date(now).toISOString(), cohort: "software" as const, path: "/",
  type: "page_view" as const,
  properties: { source: "resume-software" as const, entryCode: "abcd", referrer: "example.com", device: "desktop" as const },
};
const makeApp = (forward: Parameters<typeof websiteAnalyticsIngestion>[0] = {}) =>
  websiteAnalyticsIngestion({ token: () => token, clock: () => now, ...forward });
const send = (app: ReturnType<typeof makeApp>, events: unknown[], key = token) =>
  app.request("/events", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify({ events }) });

describe("portfolio analytics relay", () => {
  test("requires the dedicated token and forwards one validated batch", async () => {
    const forwarded: unknown[][] = [];
    const app = makeApp({ forward: async (events) => { forwarded.push(events); } });
    expect((await send(app, [event], "invalid")).status).toBe(401);
    const response = await send(app, [event, { ...event, type: "scroll", properties: { threshold: 75 } }]);
    expect(await response.json()).toEqual({ received: 2, accepted: 2 });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toHaveLength(2);
  });

  test("rejects arbitrary fields, private URLs, old or future events, and invalid engagement", async () => {
    const app = makeApp({ forward: async () => { throw new Error("should not forward"); } });
    for (const invalid of [
      { ...event, path: "/?email=x" },
      { ...event, properties: { source: "unknown", fullReferrer: "https://example.org/" } },
      { ...event, occurredAt: new Date(now - 91 * 86_400_000).toISOString() },
      { ...event, occurredAt: new Date(now + 301_000).toISOString() },
      { ...event, type: "engagement", properties: { activeMs: 50, visibleMs: 5 } },
    ]) expect((await send(app, [event, invalid])).status).toBe(400);
    expect((await send(app, Array(51).fill(event))).status).toBe(400);
  });

  test("rejects oversized requests, throttles the credential, and surfaces upstream failures", async () => {
    const app = makeApp({ forward: async () => { throw Error("upstream"); } });
    expect((await send(app, [{ ...event, path: "a".repeat(66_000) }])).status).toBe(413);
    for (let index = 1; index < 120; index++) expect((await send(app, [event])).status).toBe(502);
    expect((await send(app, [event])).status).toBe(429);
  });

  test("preserves tab sequence and only coarse browser context", () => {
    const ipId = "abcdef0123456789".repeat(2);
    const { payload } = toUmamiEvent({ ...event, ipId }, randomUUID());
    expect(payload.name).toBeUndefined();
    expect(payload.tag).toBe("software");
    expect(payload.ip).toBe("127.0.0.1");
    expect(payload.data.ipId).toBe(ipId);
    expect(payload.url).toBe("/");
    expect(payload.data.referrerHost).toBe("example.com");
    expect(payload.data.deviceClass).toBe("desktop");
    for (const referrer of ["192.168.1.20", "host.local", "localhost"]) {
      const local = toUmamiEvent({ ...event, properties: { ...event.properties, referrer } }, randomUUID());
      expect(local.payload.data.referrerHost).toBeUndefined();
    }
    expect(JSON.parse(payload.data.quantself)).toEqual({
      e: event.eventId, q: 1, t: now, p: event.pageViewId, s: event.sessionId, v: event.visitorId,
      k: "page_view", source: "resume-software", applicationCode: "abcd",
    });
  });

  test("keeps maximum allowed CTA metadata within Umami's string limit", () => {
    const { payload } = toUmamiEvent({
      ...event, type: "cta_click", seq: 2_147_483_647,
      properties: { ctaId: "repository_open", target: "t".repeat(80), contentId: "c".repeat(64) },
    }, randomUUID());
    expect(payload.data.quantself.length).toBeLessThanOrEqual(500);
  });
});

test("accepts only consistently attributed résumé redirect opens", async () => {
  const open = {
    ...event,
    type: "resume_link_open",
    path: "/go/software/project/rbc-analytics/demo",
    properties: { source: "resume-software", contentId: "rbc-analytics", target: "demo" },
  };
  const forward = mock(async () => {});
  const app = makeApp({ forward });
  expect((await send(app, [open])).status).toBe(200);
  expect((await send(app, [{ ...open, path: "/project/rbc-analytics" }])).status).toBe(400);
  expect((await send(app, [{ ...open, properties: { ...open.properties, source: "resume-web-cms" } }])).status).toBe(400);
  expect(forward).toHaveBeenCalledTimes(1);
});

test("preserves application attribution on page events and validates application redirect destinations", async () => {
  const applicationCode = "a".repeat(24);
  const forward = mock(async () => {});
  const app = makeApp({ forward });
  const open = {
    ...event, applicationCode, type: "resume_link_open",
    path: `/r/${applicationCode}/project/rbc/demo`,
    properties: { source: "resume-software", contentId: "rbc-analytics", target: "demo" },
  };
  expect((await send(app, [open])).status).toBe(200);
  expect((await send(app, [{ ...open, path: `/r/${"b".repeat(24)}/project/rbc/demo` }])).status).toBe(400);
  expect((await send(app, [{ ...open, path: `/r/${applicationCode}/profile/github` }])).status).toBe(400);
  const click = { ...event, applicationCode, type: "cta_click" as const, properties: { action: "demo_open" as const, target: "rbc-analytics" } };
  expect((await send(app, [click])).status).toBe(200);
  expect(JSON.parse(toUmamiEvent(click, randomUUID()).payload.data.quantself).applicationCode).toBe(applicationCode);
});
