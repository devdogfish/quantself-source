import { expect, test } from "bun:test";
import { clothingTimeZoneHref } from "./clothing-time-zone-sync";

test("adds the browser IANA time zone without dropping Clothing filters", () => {
  expect(
    clothingTimeZoneHref(
      "/inventory/clothing",
      new URLSearchParams("q=oxford&state=clean"),
      "America/Halifax",
    ),
  ).toBe(
    "/inventory/clothing?q=oxford&state=clean&timeZone=America%2FHalifax",
  );
});
