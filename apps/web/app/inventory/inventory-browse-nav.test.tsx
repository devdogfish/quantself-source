import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InventoryBrowseNav,
  inventorySpecialistBrowseRoutes,
} from "./inventory-browse-nav";

test("keeps Browse direct while exposing every specialist page", () => {
  const html = renderToStaticMarkup(
    <ChakraTestWrapper>
      <InventoryBrowseNav active />
    </ChakraTestWrapper>,
  );

  expect(html).toContain('href="/inventory/browse"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-label="Open Browse pages"');
  expect(inventorySpecialistBrowseRoutes).toEqual([
    { href: "/inventory/clothing", label: "Clothing" },
    { href: "/inventory/remedies", label: "Remedies" },
    { href: "/inventory/supplements", label: "Supplements" },
    { href: "/inventory/food", label: "Food" },
  ]);
});
