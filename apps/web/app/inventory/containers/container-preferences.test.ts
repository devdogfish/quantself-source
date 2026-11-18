import { describe, expect, test } from "bun:test";
import {
  CONTAINER_PREFERENCES_STORAGE_KEY,
  readContainerPreferences,
  writeContainerPreferences,
} from "./container-preferences";

describe("container preferences", () => {
  test("round-trips valid preferences", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeContainerPreferences(storage, {
      scrollContainerId: "container-two",
      version: 1,
      view: "bento",
    });

    expect(readContainerPreferences(storage)).toEqual({
      scrollContainerId: "container-two",
      version: 1,
      view: "bento",
    });
  });

  test("ignores malformed, unsupported, and invalid preferences", () => {
    for (const value of [
      "{",
      JSON.stringify({ version: 2, view: "bento" }),
      JSON.stringify({ version: 1, view: "cards" }),
      JSON.stringify({
        scrollContainerId: "",
        version: 1,
        view: "scroll",
      }),
    ]) {
      expect(
        readContainerPreferences({
          getItem: (key: string) =>
            key === CONTAINER_PREFERENCES_STORAGE_KEY ? value : null,
        }),
      ).toBeNull();
    }
  });

  test("fails silently when browser storage is unavailable", () => {
    expect(
      readContainerPreferences({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();

    expect(() =>
      writeContainerPreferences(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        { version: 1, view: "scroll" },
      ),
    ).not.toThrow();
  });
});
