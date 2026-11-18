import { expect, mock, test } from "bun:test";
import { Suspense } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import { useInventoryPanelPage } from "./use-inventory-panel-page";

let search = "";
mock.module("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));
const dom = createTestDom();
const never = new Promise<void>(() => {});
let reads = 0;
function Panel({ suspend = false }: { suspend?: boolean }) {
  const panel = useInventoryPanelPage({
    pathname: "/inventory/browse",
    initial: {
      items: [{ id: "initial" }],
      total: 1000,
      pageInfo: { nextCursor: "next" },
    },
    loadPage: async () => {
      reads++;
      return { items: [], total: 1000, pageInfo: { nextCursor: null } };
    },
  });
  if (suspend) throw never;
  return <p>{panel.availablePages.join(",")}</p>;
}

test("an abandoned suspended URL render cannot add cursor positions or start reads", async () => {
  search = "";
  reads = 0;
  await dom.render(
    <Suspense fallback={<p>Loading</p>}>
      <Panel />
    </Suspense>,
  );
  expect(dom.container.querySelector("p")?.textContent).toBe("1,2");
  search = "page=77&cursor=uncommitted";
  await dom.render(
    <Suspense fallback={<p>Loading</p>}>
      <Panel suspend />
    </Suspense>,
  );
  search = "";
  await dom.render(
    <Suspense fallback={<p>Loading</p>}>
      <Panel />
    </Suspense>,
  );
  expect(dom.container.querySelector("p")?.textContent).toBe("1,2");
  expect(reads).toBe(0);
});
