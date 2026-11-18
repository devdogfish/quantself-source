import { expect, test } from "bun:test";
import { createTestDom } from "./shared/test-dom";

const dom = createTestDom();
test("loading region announces its label, preserves content and forwards div props", async () => {
  const { LoadingRegion } = await import("./loading-region");
  await dom.render(
    <LoadingRegion id="loading-test" label="Loading notes">
      <button>Keep working</button>
    </LoadingRegion>,
  );
  const region = dom.container.querySelector<HTMLElement>("#loading-test")!;
  expect(region.getAttribute("aria-busy")).toBe("true");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.textContent).toBe("Loading notesKeep working");
  dom.container.querySelector<HTMLButtonElement>("button")!.focus();
  expect(document.activeElement?.textContent).toBe("Keep working");
});
