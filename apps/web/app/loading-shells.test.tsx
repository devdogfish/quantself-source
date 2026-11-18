import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";

const render = (ui: ReactNode) =>
  renderToStaticMarkup(<ChakraTestWrapper>{ui}</ChakraTestWrapper>);

mock.module("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

mock.module("next/navigation", () => ({
  usePathname: () => "/inventory/containers",
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

afterAll(() => {
  mock.restore();
});

describe("data-intensive route loading shells", () => {
  test("keeps container route controls visible around scene skeletons", async () => {
    const { default: ContainersLoading } =
      await import("./inventory/containers/loading");
    const { default: ContainerDetailLoading } =
      await import("./inventory/containers/[containerId]/loading");
    const { default: BoundsLoading } =
      await import("./inventory/containers/bounds/loading");
    const { default: PrototypeLoading } =
      await import("./inventory/containers/prototype/loading");

    const containers = render(<ContainersLoading />);
    const detail = render(<ContainerDetailLoading />);
    const bounds = render(<BoundsLoading />);
    const prototype = render(<PrototypeLoading />);

    expect(containers).toContain("Loading containers");
    expect(containers).toContain('aria-busy="true"');
    expect(detail).toContain("Loading container contents");
    expect(detail).toContain("Containers");
    expect(bounds).toContain("Container bounds");
    expect(bounds).toContain("Loading container bounds");
    expect(prototype).toContain("Loading container prototype");
  });

  test("keeps item and settings headers visible above data skeletons", async () => {
    const { default: ItemLoading } =
      await import("./inventory/items/[itemId]/loading");
    const { default: SettingsLoading } = await import("./settings/loading");

    const item = render(<ItemLoading />);
    const settings = render(<SettingsLoading />);

    expect(item).toContain("Item details");
    expect(item).toContain("Loading item details");
    expect(settings).toContain("Inventory Enrichment");
    expect(settings).toContain("Loading settings data");
  });
});
