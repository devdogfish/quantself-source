import { expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { createTestDom } from "./test-dom";

let pathname = "/jobs/boards";
mock.module("next/navigation", () => ({ usePathname: () => pathname }));
mock.module("next/link", () => ({
  default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch} />
  ),
}));

const dom = createTestDom();

test("PageHeader renders title, description, facts, actions and nav", async () => {
  const { PageHeader } = await import("./page-layout");
  await dom.render(<PageHeader title="Crawl history" description="All runs" actions={<button>New</button>}
    facts={[{ label: "Running now", value: 2 }, { label: "Success rate", value: "93%" }]} nav={<nav>Sub</nav>} />);
  const text = dom.container.textContent!;
  expect(dom.container.querySelector("h1")?.textContent).toBe("Crawl history");
  for (const s of ["All runs", "Running now", "2", "Success rate", "93%", "New", "Sub"]) expect(text).toContain(s);
});

test("AreaNav marks the current page with aria-current", async () => {
  const { AreaNav } = await import("./area-nav");
  const items = [{ href: "/jobs", label: "Overview", exact: true }, { href: "/jobs/boards", label: "Boards" }];
  await dom.render(<AreaNav items={items} />);
  const current = [...dom.container.querySelectorAll("a")].filter((a) => a.getAttribute("aria-current") === "page");
  expect(current.map((a) => a.textContent)).toEqual(["Boards"]);
  pathname = "/jobs/boards/42";
  await dom.render(<AreaNav items={items} />);
  expect([...dom.container.querySelectorAll("a")].filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(["Boards"]);
  pathname = "/jobs";
  await dom.render(<AreaNav items={items} />);
  expect([...dom.container.querySelectorAll("a")].filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(["Overview"]);
});

test("DataGrid shows rows as links or the empty state", async () => {
  const { DataGrid, DataGridRow } = await import("./data-panel");
  await dom.render(<DataGrid columns="1fr 1fr" headers={[{ label: "A" }, { label: "B", align: "right" }]} empty="Nothing here">{[]}</DataGrid>);
  expect(dom.container.textContent).toContain("Nothing here");
  await dom.render(<DataGrid columns="1fr 1fr" headers={[{ label: "A" }, { label: "B" }]} empty="Nothing here">
    {[<DataGridRow key="1" columns="1fr 1fr" href="/x/1"><span>one</span><span>1</span></DataGridRow>]}
  </DataGrid>);
  expect(dom.container.textContent).not.toContain("Nothing here");
  expect(dom.container.querySelector("a")?.getAttribute("href")).toBe("/x/1");
});

test("DataGrid keeps header associations local to each table and links keyboard reachable", async () => {
  const { DataGrid, DataGridRow } = await import("./data-panel");
  await dom.render(<>{["First", "Second"].map(label => (
    <DataGrid key={label} label={label} columns="1fr 1fr" headers={[{ label: "Name" }, { label: "Count" }]}>
      <DataGridRow columns="1fr 1fr" href={`/records/${label}`} prefetch={false}><span>{label}</span><span>2</span></DataGridRow>
    </DataGrid>
  ))}</>);
  const ids = new Set<string>();
  for (const table of dom.container.querySelectorAll("table")) {
    const headers = Array.from(table.querySelectorAll("th"));
    const cells = Array.from(table.querySelectorAll("tbody td"));
    expect(cells).toHaveLength(2);
    cells.forEach((cell, index) => {
      const id = cell.getAttribute("headers")!;
      expect(document.getElementById(id)).toBe(headers[index]);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    });
    const link = cells[0].querySelector("a")!;
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute("href")).toBe(`/records/${table.getAttribute("aria-label")}`);
    expect(link.getAttribute("data-prefetch")).toBe("false");
  }
});
