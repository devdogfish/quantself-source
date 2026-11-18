import { expect, test } from "bun:test";
import { receiptLibraryState } from "./library-state";

test("receipt URL state ignores merchant search, preserves subscription and cursor, and validates document type", () => {
  expect(receiptLibraryState(new URLSearchParams("q=shop&kind=invoice&cursor=next&subscriptionId=sub")))
    .toEqual({ kind: "invoice", cursor: "next", subscriptionId: "sub" });
  expect(receiptLibraryState(new URLSearchParams("kind=invalid"))).toEqual({ kind: "", cursor: "", subscriptionId: "" });
});
