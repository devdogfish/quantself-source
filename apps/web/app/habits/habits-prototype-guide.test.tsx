import { expect, test } from "bun:test";
import { createTestDom } from "@/components/shared/test-dom";

const dom = createTestDom();
const { PrototypeGuide } = await import("./habits-prototype-guide");

test("playbook preserves replacement choices, warning signs, timer reset and decision feedback", async () => {
  await dom.render(
    <PrototypeGuide variant="A" section="playbook" day={null} />,
  );
  const button = (name: string) =>
    [...dom.container.querySelectorAll("button")].find(
      (item) => item.textContent === name,
    )!;
  await dom.click(button("Drink water"));
  expect(button("Drink water").getAttribute("aria-pressed")).toBe("true");
  await dom.click(button("Hungry"));
  await dom.click(button("Tired"));
  expect(dom.container.querySelector("h1")?.textContent).toBe(
    "Go straight to a replacement.",
  );
  await dom.click(button("Start ten-minute timer"));
  expect(button("Reset timer")).toBeDefined();
  await dom.click(button("Reset timer"));
  expect(
    dom.container.querySelector('[aria-label="Time remaining"]')?.textContent,
  ).toContain("10:00");
  await dom.click(button("Ready to decide "));
  expect(dom.container.textContent).toContain(
    "Do the next planned thing on time.",
  );
  await dom.click(button("Reset playbook"));
  expect(button("Drink water").getAttribute("aria-pressed")).toBe("false");
  expect(button("Hungry").getAttribute("aria-pressed")).toBe("false");
  expect(dom.container.querySelector("h1")?.textContent).toBe(
    "Give the urge ten minutes.",
  );
});
