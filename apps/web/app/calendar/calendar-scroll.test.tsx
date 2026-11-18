import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

mock.module("../todo/todo-workspace.module.css", () => ({ default: {} }));
afterAll(() => mock.restore());

test("calendar date units cross month, year and daylight-saving boundaries", async () => {
  const { calendarDayIndex, calendarDateAt, calendarWeekIndex, calendarWeekAt } = await import("./calendar-scroll");
  expect(calendarDateAt(calendarDayIndex("2026-12-31") + 1)).toBe("2027-01-01");
  expect(calendarDateAt(calendarDayIndex("2026-11-01") + 1)).toBe("2026-11-02");
  expect(calendarWeekAt(calendarWeekIndex("2026-10-01"))).toBe("2026-09-27");
  expect(calendarWeekAt(calendarWeekIndex("2026-12-31") + 1)).toBe("2027-01-03");
});

test("rolling calendar preserves position, ignores rounding noise, and honors navigation and resize", async () => {
  const window = new Window();
  const globals = globalThis as unknown as Record<string, unknown>;
  const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let resize = () => {};
  let unitSize = 100;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value:
    name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "window" ? window : name === "ResizeObserver" ? class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} disconnect() {}
    } : (window as unknown as Record<string, unknown>)[name] });
  const { createRoot } = await import("react-dom/client");
  const { useCalendarScroll } = await import("./calendar-scroll");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const navigated: string[] = [];
  function Harness({ date, axis, buffer, snap = false, snapOnIdle = false, visibleDays = 7 }: { date: string; axis: "x" | "y"; buffer: number; snap?: boolean; snapOnIdle?: boolean; visibleDays?: number }) {
    const { ref, anchor } = useCalendarScroll({ date, axis, buffer, snap, snapOnIdle, visibleDays, getIndex: Number, getDate: String, onNavigate: next => navigated.push(next) });
    return <div ref={element => {
      ref.current = element;
      if (!element) return;
      Object.defineProperty(element, "clientWidth", { configurable: true, value: 764 });
      Object.defineProperty(element, "clientHeight", { configurable: true, value: 640 });
      element.querySelector<HTMLElement>("[data-scroll-unit]")!.getBoundingClientRect = () => ({ width: unitSize, height: unitSize }) as DOMRect;
    }} data-anchor={anchor}><div data-scroll-unit /></div>;
  }
  const viewport = () => host.firstElementChild as HTMLElement;
  const finish = async (coordinate: number, axis: "x" | "y") => act(async () => {
    if (axis === "x") viewport().scrollLeft = coordinate;
    else viewport().scrollTop = coordinate;
    viewport().dispatchEvent(new Event("scrollend"));
  });
  try {
    await act(async () => root.render(<Harness date="100" axis="x" buffer={7} snap />));
    expect(viewport().scrollLeft).toBe(700);
    viewport().scrollTop = 350;
    await finish(900, "x");
    expect(navigated).toEqual(["102"]);
    expect(viewport().dataset.anchor).toBe("102");
    expect(viewport().scrollLeft).toBe(700);
    expect(viewport().scrollTop).toBe(350);
    // Updating the URL after a gesture must not reset the recycled window.
    await act(async () => root.render(<Harness date="102" axis="x" buffer={7} snap />));
    expect(viewport().scrollLeft).toBe(700);
    unitSize = 80;
    await act(async () => resize());
    expect(viewport().scrollLeft).toBe(560);
    expect(viewport().scrollTop).toBe(350);
    await act(async () => root.render(<Harness date="200" axis="x" buffer={7} snap />));
    expect(viewport().dataset.anchor).toBe("200");
    expect(viewport().scrollLeft).toBe(560);

    unitSize = 100;
    navigated.length = 0;
    await act(async () => root.render(<Harness key="month" date="100" axis="y" buffer={6} />));
    expect(viewport().scrollTop).toBe(600);
    // Browser scroll coordinates can round just below the restored CSS position.
    await finish(599.7, "y");
    expect(navigated).toEqual([]);
    await finish(735.5, "y");
    expect(navigated).toEqual(["101"]);
    expect(viewport().scrollTop).toBeCloseTo(635.5);
    expect(viewport().dataset.anchor).toBe("101");
    await finish(viewport().scrollTop, "y");
    expect(navigated).toEqual(["101"]);
    // Repeated scrolling can continue beyond the original rendered range.
    for (let i = 0; i < 10; i++) await finish(800, "y");
    expect(viewport().dataset.anchor).toBe("121");
    expect(viewport().scrollTop).toBe(600);

    navigated.length = 0;
    await act(async () => root.render(<Harness key="year" date="2026" axis="y" buffer={1} snap />));
    await finish(200, "y");
    expect(navigated).toEqual(["2027"]);
    expect(viewport().scrollTop).toBe(100);
    await finish(0, "y");
    expect(navigated).toEqual(["2027", "2026"]);

    // Narrow screens may need to scroll inside one tall year before the next.
    unitSize = 1000;
    navigated.length = 0;
    await act(async () => root.render(<Harness key="tall-year" date="2026" axis="y" buffer={1} snap />));
    await finish(1700, "y");
    expect(navigated).toEqual([]);
    await finish(2000, "y");
    expect(navigated).toEqual(["2027"]);

    // Year snap animations must finish before recycling their targets.
    unitSize = 100;
    navigated.length = 0;
    await act(async () => root.render(<Harness key="continuous-year" date="2026" axis="y" buffer={1} snap />));
    for (let year = 2027; year <= 2036; year++) {
      for (const coordinate of [120, 160, 200]) {
        await act(async () => {
          viewport().scrollTop = coordinate;
          viewport().dispatchEvent(new Event("scroll"));
          await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
        });
        expect(viewport().dataset.anchor).toBe(String(year - 1));
      }
      await finish(200, "y");
      expect(viewport().dataset.anchor).toBe(String(year));
      expect(viewport().scrollTop).toBeCloseTo(100);
    }
    expect(navigated).toHaveLength(10);
    await finish(100, "y");
    expect(navigated).toHaveLength(10);
    for (let year = 2035; year >= 2026; year--) {
      for (const coordinate of [80, 40, 0]) {
        await act(async () => {
          viewport().scrollTop = coordinate;
          viewport().dispatchEvent(new Event("scroll"));
          await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
        });
        expect(viewport().dataset.anchor).toBe(String(year + 1));
      }
      await finish(0, "y");
      expect(viewport().dataset.anchor).toBe(String(year));
      expect(viewport().scrollTop).toBeCloseTo(100);
    }
    expect(navigated).toHaveLength(20);

    navigated.length = 0;
    await act(async () => root.render(<Harness key="month-snap" date="100" axis="y" buffer={6} snap />));
    for (const coordinate of [620, 660, 700]) {
      await act(async () => {
        viewport().scrollTop = coordinate;
        viewport().dispatchEvent(new Event("scroll"));
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
      expect(viewport().dataset.anchor).toBe("100");
      expect(navigated).toEqual([]);
    }
    await finish(700, "y");
    expect(viewport().dataset.anchor).toBe("101");
    expect(viewport().scrollTop).toBe(600);

    // Month/year refill during an uninterrupted gesture, including held touch.
    for (const buffer of [6, 1]) {
      unitSize = 100;
      navigated.length = 0;
      await act(async () => root.render(<Harness key={`free-vertical-${buffer}`} date="100" axis="y" buffer={buffer} />));
      viewport().dispatchEvent(new Event("pointerdown"));
      for (let step = 1; step <= 20; step++) {
        await act(async () => {
          viewport().scrollTop = (buffer + 1) * unitSize + 35;
          viewport().dispatchEvent(new Event("scroll"));
          await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
        });
        expect(viewport().dataset.anchor).toBe(String(100 + step));
        expect(viewport().scrollTop).toBe(buffer * unitSize + 35);
      }
      for (let step = 1; step <= 20; step++) {
        await act(async () => {
          viewport().scrollTop = (buffer - 1) * unitSize + 35;
          viewport().dispatchEvent(new Event("scroll"));
          await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
        });
        expect(viewport().dataset.anchor).toBe(String(120 - step));
        expect(viewport().scrollTop).toBe(buffer * unitSize + 35);
      }
      expect(navigated).toHaveLength(40);
      await act(async () => {
        viewport().dispatchEvent(new Event("scroll"));
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
      expect(navigated).toHaveLength(40);
      window.dispatchEvent(new window.Event("pointerup"));
    }

    // Idle snapping never consumes active input, and new input cancels the snap.
    for (const buffer of [6, 1]) {
      unitSize = 100;
      await act(async () => root.render(<Harness key={`idle-${buffer}`} date="100" axis="y" buffer={buffer} snapOnIdle />));
      const scrolls: ScrollToOptions[] = [];
      Object.defineProperty(viewport(), "scrollTo", { configurable: true, value: (options: ScrollToOptions) => { scrolls.push(options); } });
      viewport().dispatchEvent(new Event("pointerdown"));
      await act(async () => {
        viewport().scrollTop = (buffer + 1) * 100 + 35;
        viewport().dispatchEvent(new Event("scroll"));
        await new Promise(resolve => setTimeout(resolve, 200));
      });
      expect(scrolls).toHaveLength(0);
      expect(viewport().dataset.anchor).toBe("101");
      expect(viewport().scrollTop).toBe(buffer * 100 + 35);
      window.dispatchEvent(new window.Event("pointerup"));
      for (let i = 0; i < 3; i++) {
        const event = new window.WheelEvent("wheel", { deltaY: 20, cancelable: true });
        viewport().dispatchEvent(event as unknown as Event);
        expect(event.defaultPrevented).toBe(false);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
        expect(scrolls).toHaveLength(0);
      }
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
      expect(scrolls).toEqual([{ top: buffer * 100, behavior: "smooth" }]);
      viewport().dispatchEvent(new window.WheelEvent("wheel", { deltaY: 100 }) as unknown as Event);
      expect(scrolls[1]).toEqual({ top: buffer * 100 + 35, behavior: "instant" });
      await act(async () => {
        viewport().scrollTop = (buffer + 1) * 100 + 55;
        viewport().dispatchEvent(new Event("scroll"));
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
      expect(viewport().dataset.anchor).toBe("102");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
      expect(scrolls[2]).toEqual({ top: (buffer + 1) * 100, behavior: "smooth" });
      await finish((buffer + 1) * 100, "y");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
      expect(viewport().dataset.anchor).toBe("103");
      expect(viewport().scrollTop).toBe(buffer * 100);
    }

    // Weekly momentum must not be interrupted by recycling ordinary gestures.
    navigated.length = 0;
    await act(async () => root.render(<Harness key="week-momentum" date="100" axis="x" buffer={7} />));
    viewport().scrollTop = 480;
    await act(async () => {
      viewport().scrollLeft = 835;
      viewport().dispatchEvent(new Event("scroll"));
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    expect(viewport().dataset.anchor).toBe("100");
    expect(viewport().scrollLeft).toBe(835);
    expect(navigated).toEqual([]);
    await finish(835, "x");
    expect(viewport().dataset.anchor).toBe("101");
    expect(viewport().scrollLeft).toBeCloseTo(735);
    expect(viewport().scrollTop).toBe(480);
    // Long gestures still refill before exhausting the offscreen days.
    await act(async () => {
      viewport().scrollLeft = 1335;
      viewport().dispatchEvent(new Event("scroll"));
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    expect(viewport().dataset.anchor).toBe("107");
    expect(viewport().scrollLeft).toBeCloseTo(735);
    await act(async () => {
      viewport().scrollLeft = 65;
      viewport().dispatchEvent(new Event("scroll"));
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    expect(viewport().dataset.anchor).toBe("100");
    expect(viewport().scrollLeft).toBeCloseTo(765);

    navigated.length = 0;
    await act(async () => root.render(<Harness key="day" date="100" axis="x" buffer={1} visibleDays={1} snap />));
    expect(viewport().style.getPropertyValue("--calendar-day-width")).toBe("700px");
    viewport().scrollTop = 480;
    // Snapping a full-width day must finish before its snap targets are recycled.
    for (const coordinate of [120, 160, 190, 200]) {
      await act(async () => {
        viewport().scrollLeft = coordinate;
        viewport().dispatchEvent(new Event("scroll"));
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
      expect(viewport().dataset.anchor).toBe("100");
      expect(navigated).toEqual([]);
    }
    await finish(200, "x");
    expect(navigated).toEqual(["101"]);
    expect(viewport().scrollLeft).toBe(100);
    expect(viewport().scrollTop).toBe(480);
    await finish(0, "x");
    expect(navigated).toEqual(["101", "100"]);
    expect(viewport().scrollTop).toBe(480);

    // Native scrollend can arrive at a fractional position after snap targets recycle.
    await act(async () => root.render(<Harness key="snap-recovery" date="100" axis="x" buffer={7} snap />));
    viewport().scrollTop = 480;
    await finish(735, "x");
    expect(viewport().scrollLeft).toBe(700);
    expect(viewport().scrollTop).toBe(480);
    await finish(865, "x");
    expect(viewport().scrollLeft).toBe(700);
    expect(viewport().dataset.anchor).toBe("102");

    // Advertising scrollend support does not guarantee an event after pointer release.
    Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
    await act(async () => root.render(<Harness key="missing-scrollend" date="100" axis="x" buffer={7} snap />));
    viewport().dispatchEvent(new Event("pointerdown"));
    await act(async () => {
      viewport().scrollLeft = 835;
      viewport().dispatchEvent(new Event("scroll"));
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(viewport().scrollLeft).toBe(835); // Never fight a held gesture.
    await act(async () => {
      window.dispatchEvent(new window.Event("pointerup"));
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(viewport().scrollLeft).toBe(700);
    expect(viewport().dataset.anchor).toBe("101");

    // Native gestures remain uncancelled in every view, including momentum.
    for (const config of [
      { key: "day-wheel", axis: "x" as const, buffer: 1, visibleDays: 1 },
      { key: "week-wheel", axis: "x" as const, buffer: 7, visibleDays: 7 },
      { key: "month-wheel", axis: "y" as const, buffer: 6, visibleDays: 7 },
      { key: "year-wheel", axis: "y" as const, buffer: 1, visibleDays: 7 },
    ]) {
      unitSize = 100;
      await act(async () => root.render(<Harness key={config.key} date="100" axis={config.axis} buffer={config.buffer} visibleDays={config.visibleDays} snap />));
      for (const amount of [20, 100, 800, -800]) {
        const event = new window.WheelEvent("wheel", {
          deltaX: config.axis === "x" ? amount : 0,
          deltaY: config.axis === "y" ? amount : 0,
          cancelable: true,
        });
        viewport().dispatchEvent(event as unknown as Event);
        expect(event.defaultPrevented).toBe(false);
      }
      navigated.length = 0;
      await finish((config.buffer + 3) * unitSize, config.axis);
      expect(navigated).toEqual(["103"]);
      expect(config.axis === "x" ? viewport().scrollLeft : viewport().scrollTop).toBe(config.buffer * unitSize);
    }
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
  }
});
