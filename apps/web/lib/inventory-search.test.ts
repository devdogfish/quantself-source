import { describe, expect, test } from "bun:test";
import {
  buildInventorySearchCorpus,
  inventorySearchTerms,
  matchesInventorySearchQuery,
} from "./inventory-search";

describe("inventory search", () => {
  test("uses normalized substring terms across every inventory surface", () => {
    const corpus = buildInventorySearchCorpus([
      "My iPhone",
      "Upstairs office",
    ]);

    expect(matchesInventorySearchQuery(corpus, "phone")).toBe(true);
    expect(matchesInventorySearchQuery(corpus, "PHONE office")).toBe(true);
    expect(matchesInventorySearchQuery(corpus, "phone kitchen")).toBe(false);
  });

  test("normalizes punctuation and deduplicates query terms", () => {
    expect(inventorySearchTerms(" CAD 12.50 cad ")).toEqual([
      "cad",
      "12",
      "50",
    ]);
  });
});
