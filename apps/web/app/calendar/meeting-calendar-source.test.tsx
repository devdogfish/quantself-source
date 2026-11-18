import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";

const toasts: { title?: string }[] = [];
mock.module("@/components/chakra/toaster", () => ({ toaster: { create: (toast: { title?: string }) => toasts.push(toast) } }));

const dom = createTestDom();
const meeting = {
  id: "11111111-1111-4111-8111-111111111111", start: "2026-11-17T13:00:00Z", end: "2026-11-17T13:30:00Z",
  guestName: "Ada Lovelace", guestEmail: "ada@example.com", note: "Website project", jitsiUrl: "https://meet.example.test/meet-1",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });

test("meetingItems places meetings on Halifax wall dates inside the range", async () => {
  const { meetingItems } = await import("./meeting-calendar-source");
  expect(meetingItems([meeting], { from: "2026-11-17", to: "2026-11-17" })).toEqual([
    { date: "2026-11-17", start: "09:00", finish: "09:30", minutes: 30, meeting },
  ]);
  expect(meetingItems([{ ...meeting, start: "2026-11-18T03:30:00Z", end: "2026-11-18T04:00:00Z" }], { from: "2026-11-17", to: "2026-11-17" }))
    .toMatchObject([{ date: "2026-11-17", start: "23:30", minutes: 30 }]);
  expect(meetingItems([meeting], { from: "2026-11-18", to: "2026-11-20" })).toEqual([]);
});

test("loads a range in one request, hides a cancel at once and restores it when the API rejects", async () => {
  const requests: string[] = [];
  const cancels: ((response: Response) => void)[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: Request) => {
    const url = new URL(input.url);
    requests.push(`${input.method} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/cancel")) return new Promise<Response>(resolve => cancels.push(resolve));
    return json({ meetings: [meeting] });
  }) as typeof fetch;
  try {
    const { useMeetingCalendar } = await import("./meeting-calendar-source");
    const { MeetingDetailsDialog } = await import("./meeting-details-dialog");
    let lane!: ReturnType<typeof useMeetingCalendar>;
    function Lane() {
      lane = useMeetingCalendar("2026-11-15", "2026-11-21", true);
      return <>
        {[...lane.byDate.values()].flat().map(item => lane.source.render(item, { style: {}, week: true, compact: false, detailed: true, ...lane.source.interact(item) }))}
        <MeetingDetailsDialog item={lane.selected} canCancel onClose={lane.close} />
      </>;
    }
    await dom.render(<Lane />);
    await settle();
    expect(requests).toEqual(["GET /api/v1/meetings/booked?from=2026-11-14T00%3A00%3A00.000Z&to=2026-11-23T00%3A00%3A00.000Z"]);
    const block = () => document.querySelector<HTMLElement>(`[data-meeting-id="${meeting.id}"] button`);
    expect(block()?.getAttribute("aria-label")).toContain("Meeting with Ada Lovelace");

    await dom.click(block()!);
    await settle();
    const text = document.body.textContent ?? "";
    for (const detail of ["ada@example.com", "Website project", "https://meet.example.test/meet-1", "09:00–09:30"]) expect(text).toContain(detail);
    const button = (label: string) => [...document.querySelectorAll("button")].find(element => element.textContent === label)!;
    await dom.click(button("Cancel meeting"));
    await dom.click(button("Cancel and email guest"));
    await settle();
    // Optimistic: gone before the API answers.
    expect(block()).toBeNull();
    expect(requests.at(-1)).toBe(`POST /api/v1/meetings/${meeting.id}/cancel`);

    await act(async () => cancels[0]!(json({ code: "MEETING_STARTED", message: "This meeting has already started." }, 409)));
    await settle();
    expect(block()).not.toBeNull();
    expect(toasts.at(-1)?.title).toBe("Call with Ada Lovelace is still booked");

    await dom.click(block()!);
    await settle();
    await dom.click(button("Cancel meeting"));
    await dom.click(button("Cancel and email guest"));
    await settle();
    expect(block()).toBeNull();
    const getsBefore = requests.filter(request => request.startsWith("GET")).length;
    await act(async () => cancels[1]!(json({ id: meeting.id, start: meeting.start, end: meeting.end })));
    await settle();
    // The confirmed cancel stays hidden even though the refetch below still returns the meeting.
    expect(requests.filter(request => request.startsWith("GET")).length).toBe(getsBefore + 1);
    expect(block()).toBeNull();
  } finally {
    globalThis.fetch = previous;
  }
});
