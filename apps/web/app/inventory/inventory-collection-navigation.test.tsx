import { expect, mock, test } from "bun:test";
import { createTestDom } from "@/components/shared/test-dom";

mock.module("next/link", () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: React.ComponentProps<"a"> & { href: string; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
mock.module("next/navigation", () => ({
  usePathname: () => "/inventory/archive",
}));
const dom = createTestDom();

test("archive stays reachable from the shared Inventory header", async () => {
  const { InventoryShellLayout } = await import("./inventory-shell");
  await dom.render(
    <InventoryShellLayout
      active="browse"
      title="Inventory archive"
      titleMeta="2 archived"
    >
      <p>Archived items</p>
    </InventoryShellLayout>,
  );
  expect(dom.container.querySelector("h1")?.textContent).toBe(
    "Inventory archive",
  );
  const nav = dom.container.querySelector('nav[aria-label="Inventory routes"]');
  expect(nav?.querySelector('a[href="/inventory/archive"]')?.textContent).toBe(
    "Archive",
  );
  expect(dom.container.textContent).toContain("2 archived");
});

test("Browse menu keeps specialist destinations reachable", async () => {
  const { InventoryBrowseNav } = await import("./inventory-browse-nav");
  await dom.render(<InventoryBrowseNav active />);
  await dom.click(
    dom.container.querySelector('button[aria-label="Open Browse pages"]')!,
  );
  for (const name of ["clothing", "remedies", "supplements", "food"]) {
    expect(
      document.querySelector(`[role="menuitem"][href="/inventory/${name}"]`),
    ).not.toBeNull();
  }
});

test("processing search and stage filters remain immediately usable", async () => {
  const { InventoryProcessingBoard } =
    await import("./inventory-processing-board");
  const { getInventoryShellProcessingColumns, inventoryShellItems } =
    await import("./inventory-shell-data");
  await dom.render(
    <InventoryProcessingBoard
      columns={getInventoryShellProcessingColumns(inventoryShellItems)}
    />,
  );
  const input = dom.container.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  await dom.type(input, "not a matching item");
  expect(dom.container.querySelectorAll('a[aria-label^="Open "]').length).toBe(
    0,
  );
  await dom.click(
    [...dom.container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Filter"),
    )!,
  );
  expect(document.querySelector('input[name="needs-review"]')).not.toBeNull();
  await dom.click(document.querySelector('input[name="needs-review"]')!);
  expect(
    [...dom.container.querySelectorAll("h2")].some((h) =>
      h.textContent?.includes("Needs review"),
    ),
  ).toBe(false);
  await dom.click(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear",
    )!,
  );
  expect(input.value).toBe("");
  expect(dom.container.querySelector('a[aria-label^="Open "]')).not.toBeNull();
});
