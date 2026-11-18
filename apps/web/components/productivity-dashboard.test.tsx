import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";

mock.module("@/components/productivity-signal-chart", () => ({
  ProductivitySignalChart: ({
    data,
  }: {
    data: Array<{ date: Date; energy: number }>;
  }) => (
    <div
      data-testid="signals"
      data-energy={data.at(-1)?.energy}
      data-timestamps={JSON.stringify(
        data.map((point) => point.date.getTime()),
      )}
    />
  ),
}));

const dom = createTestDom();

test("timer controls and Chakra signal sliders update dashboard state", async () => {
  const { ProductivityDashboard } = await import("./productivity-dashboard");
  await dom.render(<ProductivityDashboard />);

  await clickButton("Start");
  expect(findButton("Pause")).toBeDefined();
  await clickButton("Pause");
  expect(findButton("Resume")).toBeDefined();
  await clickButton("Resume");
  expect(findButton("Pause")).toBeDefined();

  const energySlider = dom.container.querySelector<HTMLElement>(
    '[role="slider"][aria-label="Energy"]',
  )!;
  expect(energySlider.getAttribute("aria-valuenow")).toBe("67");
  await act(async () => {
    energySlider.focus();
    energySlider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(energySlider.getAttribute("aria-valuenow")).toBe("68");
  expect(
    dom.container
      .querySelector('[data-testid="signals"]')
      ?.getAttribute("data-energy"),
  ).toBe("68");
});

test("adjust drawer exposes labeled plan inputs and closes with Escape", async () => {
  const { ProductivityDashboard } = await import("./productivity-dashboard");
  await dom.render(<ProductivityDashboard />);
  await clickButton("Adjust");

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.textContent).toContain("Adjust Plan");
  const labels = Array.from(dialog.querySelectorAll("label"));
  expect(labels.some((label) => label.textContent === "Time")).toBe(true);
  expect(labels.some((label) => label.textContent === "Type")).toBe(true);
  expect(labels.some((label) => label.textContent === "Mode")).toBe(true);
  expect(labels.some((label) => label.textContent === "Duration")).toBe(true);
  for (const label of labels) {
    expect(document.getElementById(label.htmlFor)).not.toBeNull();
  }
  await act(async () => {
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

function findButton(text: string) {
  return Array.from(
    dom.container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent?.trim() === text);
}

async function clickButton(text: string) {
  const button = findButton(text);
  if (!button) throw new Error(`Expected button ${text}`);
  await act(async () => button.click());
}

test("signal model stays within one ordered sample day after the live clock updates", async () => {
  const { ProductivityDashboard } = await import("./productivity-dashboard");
  await dom.render(<ProductivityDashboard />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const timestamps: number[] = JSON.parse(
    dom.container
      .querySelector('[data-testid="signals"]')!
      .getAttribute("data-timestamps")!,
  );
  expect(timestamps).toHaveLength(7);
  expect(
    timestamps.every(
      (time, index) => index === 0 || time > timestamps[index - 1]!,
    ),
  ).toBe(true);
  expect(
    new Set(timestamps.map((time) => new Date(time).toDateString())).size,
  ).toBe(1);
  expect((timestamps.at(-1)! - timestamps[0]!) / 3_600_000).toBe(7);
  expect(dom.container.textContent).toContain("Sample day, 09:00–16:00");
});
