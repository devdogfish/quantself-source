import { expect, test } from "bun:test";
import { convertUmamiWebsiteEvent } from "../scripts/import-website-events";
import { toUmamiEvent } from "./website-analytics-route";

const common = {
  eventId: "10000000-0000-4000-8000-000000000001",
  visitorId: "10000000-0000-4000-8000-000000000002",
  sessionId: "10000000-0000-4000-8000-000000000003",
  pageViewId: "10000000-0000-4000-8000-000000000004",
  occurredAt: "2026-11-14T18:00:00Z",
  seq: 3,
} as const;
function convert(event: Parameters<typeof toUmamiEvent>[0]) {
  const { payload } = toUmamiEvent(event, "20000000-0000-4000-8000-000000000001");
  const { data } = payload;
  return convertUmamiWebsiteEvent({
    row_id: event.eventId, path: payload.url, metadata: data.quantself,
    referrer: data.referrerHost ?? null, device: data.deviceClass ?? null, ip_id: data.ipId ?? null,
    utm_source: null, utm_medium: null, utm_campaign: null,
  });
}

test("legacy relay source is retained independently of actual UTM values", () => {
  for (const source of ["direct", "resume-software"] as const) {
    expect(convert({ ...common, type: "page_view", cohort: "software", path: "/", properties: { source } }))
      .toMatchObject({ id: common.eventId, kind: "page:view", utmSource: null, props: { source, seq: 3 } });
  }
});

test("nested legacy résumé redirect preserves attribution, target and original client UUID", () => {
  const applicationCode = "a".repeat(24);
  expect(convert({
    ...common, type: "resume_link_open", cohort: "software", applicationCode,
    path: `/r/${applicationCode}/project/rbc/source/docs`, ipId: "b".repeat(32),
    properties: { source: "resume-software", contentId: "rbc", target: "repository" },
  })).toMatchObject({
    id: common.eventId, kind: "link:open", linkCode: applicationCode, ipId: "b".repeat(32),
    path: `/r/${applicationCode}/project/rbc/source/docs`,
    props: { seq: 3, source: "resume-software", contentId: "rbc", target: "repository" },
  });
});

test("legacy booking completion remains distinguishable from a contact form submission", () => {
  const event = { ...common, type: "contact_success", cohort: "default", path: "/contact" } as const;
  expect(convert({ ...event, properties: { method: "form" } }))
    .toMatchObject({ kind: "contact_form:submit", props: { method: "form" } });
  expect(convert({ ...event, properties: { method: "booking" } }))
    .toMatchObject({ kind: "cta:click", props: { cta: "booking", method: "booking" } });
});
