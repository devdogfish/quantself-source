import { beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";

const testDom = createTestDom();

beforeEach(() => {
  // Give charts a size: happy-dom has no layout.
  const proto = window.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    return this.tagName === "SPAN"
      ? new window.DOMRect(0, 0, 40, 14)
      : new window.DOMRect(0, 0, 640, 320);
  };
});

test("renders all six signals and exposes caffeine amount in the keyboard tooltip", async () => {
  const { ProductivitySignalChart } =
    await import("./productivity-signal-chart");
  const data = [
    {
      date: new Date("2026-10-25T09:00:00"),
      productivity: 50,
      focus: 60,
      energy: 70,
      caffeineLoad: 30,
      caffeineMg: 90,
      foodStability: 40,
      substanceLoad: 8,
    },
    {
      date: new Date("2026-10-25T10:00:00"),
      productivity: 55,
      focus: 65,
      energy: 75,
      caffeineLoad: 35,
      caffeineMg: 105,
      foodStability: 45,
      substanceLoad: 8,
    },
  ];
  await testDom.render(<ProductivitySignalChart data={data} />);

  expect(testDom.container.querySelectorAll(".recharts-line-curve").length).toBe(6);
  for (const label of [
    "Productivity",
    "Focus",
    "Energy",
    "Caffeine",
    "Food",
    "Substance",
  ]) {
    expect(testDom.container.textContent).toContain(label);
  }
  const chart = testDom.container.querySelector<SVGElement>(".recharts-surface")!;
  await act(async () => {
    chart.focus();
    chart.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(testDom.container.textContent).toContain("105mg");
  expect(testDom.container.textContent).not.toContain("Invalid Date");
});
