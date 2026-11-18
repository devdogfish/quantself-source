import { expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { createTestDom } from "./test-dom";

let search = "";
const replace = mock((url: string) => { search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : ""; });
mock.module("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace }),
  usePathname: () => "/pages",
}));

const dom = createTestDom();

test("useUrlState reads values, writes non-defaults and drops defaults", async () => {
  const { useUrlState } = await import("./url-state");
  const probe: { api?: ReturnType<typeof useUrlState<{ status: string; q: string }>> } = {};
  function Probe() {
    const state = useUrlState({ status: "all", q: "" });
    useEffect(() => { probe.api = state; });
    return <span>{state[0].status}|{state[0].q}</span>;
  }
  search = "q=foo";
  await dom.render(<Probe />);
  expect(dom.container.querySelector("span")!.textContent).toBe("all|foo");

  const { act } = await import("react");
  await act(async () => probe.api![1]({ status: "failed" }));
  expect(replace).toHaveBeenLastCalledWith("/pages?status=failed&q=foo", { scroll: false });
  await dom.render(<Probe />);
  expect(dom.container.querySelector("span")!.textContent).toBe("failed|foo");

  await act(async () => probe.api![1]({ status: "all", q: "" }));
  expect(replace).toHaveBeenLastCalledWith("/pages", { scroll: false });
});

test("useBrowserState persists, validates and survives broken storage", async () => {
  const { useBrowserState, isBoolean, readBrowserState } = await import("./browser-state");
  const { act } = await import("react");
  localStorage.setItem("k", JSON.stringify("not-bool"));
  const probe: { api?: ReturnType<typeof useBrowserState<boolean>> } = {};
  function Probe() {
    const state = useBrowserState("k", false, isBoolean);
    useEffect(() => { probe.api = state; });
    return <span>{String(state[0])}</span>;
  }
  await dom.render(<Probe />);
  expect(dom.container.querySelector("span")!.textContent).toBe("false");
  await act(async () => probe.api![1](true));
  expect(localStorage.getItem("k")).toBe("true");
  expect(readBrowserState("k", false, isBoolean)).toBe(true);
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => { throw new Error("blocked"); };
  await act(async () => probe.api![1](false));
  expect(dom.container.querySelector("span")!.textContent).toBe("false");
  localStorage.setItem = real;
});
