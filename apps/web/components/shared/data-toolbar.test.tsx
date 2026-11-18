import { expect, mock, test } from "bun:test";
import { useState } from "react";
import { act } from "react";
import { createTestDom } from "./test-dom";

const dom = createTestDom();
const q = (s: string) => dom.container.querySelector(s) as HTMLElement | null;
const byLabel = (l: string) => q(`[aria-label="${l}"]`)!;

test("search types, clears; segment change, copy confirmation and download call back", async () => {
  const { DataToolbar } = await import("./data-toolbar");
  const onValue = mock<(v: string) => void>(() => {});
  const onCopy = mock(() => {});
  const onDownload = mock(() => {});
  const seen: string[] = [];
  function Harness() {
    const [query, setQuery] = useState("");
    seen.push(query);
    return <DataToolbar query={query} onQuery={setQuery} placeholder="Search rows"
      segments={[{ value: "all", label: "All 3" }, { value: "bad", label: "Bad 1" }]} value="all" onValue={onValue}
      count="3 matches" copyLabel="Copy ids" onCopy={onCopy} downloadLabel="Download csv" onDownload={onDownload} />;
  }
  await dom.render(<Harness />);
  expect(q('[aria-label="Clear search"]')).toBeNull();
  await dom.type(byLabel("Search rows") as HTMLInputElement, "abc");
  expect((byLabel("Search rows") as HTMLInputElement).value).toBe("abc");
  await dom.click(byLabel("Clear search"));
  expect((byLabel("Search rows") as HTMLInputElement).value).toBe("");
  expect(q('[aria-label="Clear search"]')).toBeNull();

  const bad = [...dom.container.querySelectorAll("label")].find((l) => l.textContent === "Bad 1")!;
  await dom.click(bad.querySelector("input")!);
  expect(onValue).toHaveBeenCalledWith("bad");

  expect(dom.container.textContent).toContain("3 matches");
  await dom.click(byLabel("Copy"));
  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(q('[aria-label="Copied"]')).not.toBeNull();
  await dom.click(byLabel("Download"));
  expect(onDownload).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
  expect(q('[aria-label="Copy"]')).not.toBeNull();
});

test("downloadText creates an object URL for the file and clicks a download link", async () => {
  const { downloadText } = await import("./data-toolbar");
  const created: Blob[] = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((b: Blob) => { created.push(b); return "blob:x"; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  const clicked: string[] = [];
  const origCreate = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const el = origCreate(tag);
    if (tag === "a") el.click = () => { clicked.push((el as HTMLAnchorElement).download); };
    return el;
  }) as typeof document.createElement;
  try {
    downloadText("a,b", "x.csv", "text/csv");
  } finally {
    URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;
  }
  expect(clicked).toEqual(["x.csv"]);
  expect(await created[0].text()).toBe("a,b");
});
