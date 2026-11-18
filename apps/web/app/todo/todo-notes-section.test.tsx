import { afterAll, expect, jest, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
mock.module("./todo-notes-section.module.css", () => ({ default: {} }));
mock.module("./jarvis-ui", () => ({ useJarvisDraft: () => {} }));
mock.module("./todo-notes-editor", () => ({ TodoNotesEditor: ({ value, onCommit }: { value: string; onCommit(before: string, after: string): void }) => <textarea aria-label="Notes" defaultValue={value} onBlur={event => { if (event.target.value !== value) onCommit(value, event.target.value); }} /> }));
afterAll(() => mock.restore());

test("URLs require valid web addresses, normalize bare domains and retain unsafe or arbitrary text", async () => {
  const { normalizeTaskUrl, taskUrlHref } = await import("./task-urls");
  expect(normalizeTaskUrl("example.com/path")).toBe("https://example.com/path");
  expect(taskUrlHref("https://www.rbc.com")).toBe("https://www.rbc.com/");
  expect(taskUrlHref("example.com")).toBe("https://example.com/");
  expect(normalizeTaskUrl(" example.com ")).toBe("https://example.com");
  expect(normalizeTaskUrl(" https://example.com ")).toBe("https://example.com");
  expect(taskUrlHref(" https://example.com ")).toBe("https://example.com/");
  for (const value of ["\texample.com", "example.com\n", "https://example.com/unsafe\tspace", "https:dsl", "https:/dsl", "javascript:alert(1)", "mailto:a@example.com", "some useful text", "https://example.com/unsafe space"]) {
    expect(taskUrlHref(value)).toBeNull();
    expect(normalizeTaskUrl(value)).toBe(value);
  }
});

async function setup() {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as any)[key] });
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoNotesSection } = await import("./todo-notes-section");
  const host = document.createElement("div"); document.body.append(host);
  const outside = document.createElement("button"); document.body.append(outside);
  const root = createRoot(host), commits: string[][] = [], notesCommits: string[][] = [];
  let fail = false;
  const render = (notes = "", urls = "") => act(async () => root.render(<ChakraTestWrapper><TodoNotesSection notes={notes} urls={urls} readOnly={false} onNotesCommit={(before, after) => notesCommits.push([before, after])} onUrlsCommit={(before, after) => { if (fail) throw Error("Queue unavailable"); commits.push([before, after]); }} /></ChakraTestWrapper>));
  const button = (text: string) => [...host.querySelectorAll("button")].find(element => element.textContent === text);
  const input = (label = "URL") => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const focus = (element: HTMLElement) => act(async () => { element.focus(); await new Promise(resolve => setTimeout(resolve, 5)); });
  const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (element: HTMLElement, key: string) => act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  const click = (element: HTMLElement) => act(async () => { element.click(); });
  const close = async () => {
    await act(async () => root.unmount()); host.remove(); outside.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  };
  return { host, outside, commits, notesCommits, render, button, input, focus, type, key, click, close, fail: () => { fail = true; } };
}

test("valid blurred URLs display actual linked text; keyboard focus restores editing and Enter keeps rows open", async () => {
  const t = await setup();
  try {
    await t.render("Saved note", "https://www.rbc.com");
    const link = t.host.querySelector<HTMLAnchorElement>('a[href="https://www.rbc.com/"]')!;
    expect(link).not.toBeNull(); expect(link.textContent).toBe("https://www.rbc.com");
    expect(link.textContent).not.toContain("↗");
    await t.focus(t.input());
    expect(t.input().value).toBe("https://www.rbc.com"); expect(document.activeElement).toBe(t.input());
    await t.type(t.input(), "example.com"); await t.key(t.input(), "Enter");
    expect(t.input("URL 2")).not.toBeNull(); expect(document.activeElement).toBe(t.input("URL 2"));
    expect(t.button("Add URL or Attachments")).toBeUndefined();
    await t.type(t.input("URL 2"), "https:dsl");
    expect(t.input("URL 2").getAttribute("aria-invalid")).toBe("true");
    expect(t.host.querySelector('[role="status"]')).toBeNull();
    await t.focus(t.outside);
    expect(t.commits.at(-1)?.[1]).toBe("https://example.com\nhttps:dsl");
    expect(t.input("URL 2").value).toBe("https:dsl");
    expect(t.input("URL 2").hasAttribute("aria-invalid")).toBe(false);
    expect(t.host.querySelector('[role="status"]')).toBeNull();
    const plainText = [...t.host.querySelectorAll("span")].find(element => element.textContent === "https:dsl")!;
    expect(plainText).toBeDefined();
    await t.click(plainText);
    expect(document.activeElement).toBe(t.input("URL 2"));
    expect(t.input("URL 2").getAttribute("aria-invalid")).toBe("true");
    await t.type(t.input("URL 2"), "https://www.rbc.com");
    expect(t.input("URL 2").hasAttribute("aria-invalid")).toBe(false);
    await t.focus(t.outside);
    expect(t.host.querySelector('a[href="https://www.rbc.com/"]')).not.toBeNull();
    expect(t.host.querySelector('a[href="https://dsl/"]')).toBeNull();
  } finally { await t.close(); }
});

test("empty extras collapse at notes boundary; blank section collapses outside and ghost stays inert", async () => {
  const t = await setup();
  try {
    await t.render("Saved note");
    await t.click(t.button("Add URL or Attachments")!);
    const attachment = t.button("Add Attachment…")!;
    expect(attachment.disabled).toBe(false); expect(attachment.getAttribute("aria-disabled")).toBe("true");
    await t.focus(t.input()); await t.focus(attachment);
    expect(document.activeElement).toBe(attachment); expect(t.input()).not.toBeNull();
    await t.click(attachment);
    expect(t.commits).toEqual([]); expect(t.notesCommits).toEqual([]);
    expect(t.input()).not.toBeNull();
    const savedNotes = t.host.querySelector<HTMLTextAreaElement>('[aria-label="Notes"]')!;
    await t.focus(savedNotes);
    expect(document.activeElement).toBe(savedNotes); expect(t.input()).toBeNull();
    expect(t.button("Add URL or Attachments")).toBeDefined();
    await t.focus(t.outside);
    expect(t.input()).toBeNull(); expect(t.button("Add URL or Attachments")).toBeDefined();
    expect(t.host.querySelector<HTMLTextAreaElement>('[aria-label="Notes"]')!.value).toBe("Saved note");
    expect(t.commits).toEqual([]);
    const notes = t.host.querySelector<HTMLTextAreaElement>('[aria-label="Notes"]')!;
    await t.focus(notes); await t.type(notes, ""); await t.focus(t.outside);
    expect(t.notesCommits.at(-1)).toEqual(["Saved note", ""]);
    await t.click(t.button("Add Notes, URL, or Attachments")!);
    await t.focus(t.input()); await t.focus(t.button("Add Attachment…")!);
    expect(t.input()).not.toBeNull();
    const blankNotes = t.host.querySelector<HTMLTextAreaElement>('[aria-label="Notes"]')!;
    await t.focus(blankNotes);
    expect(document.activeElement).toBe(blankNotes); expect(t.input()).toBeNull();
    expect(t.button("Add URL or Attachments")).toBeDefined();
    expect(t.button("Add Notes, URL, or Attachments")).toBeUndefined();
    await t.focus(t.outside);
    expect(t.button("Add Notes, URL, or Attachments")).toBeDefined();
    expect(t.host.querySelector('[aria-label="Notes"]')).toBeNull();
  } finally { await t.close(); }
});

test("arbitrary invalid text and rejected/oversized drafts remain visible after blur", async () => {
  const t = await setup();
  try {
    await t.render(); await t.click(t.button("Add Notes, URL, or Attachments")!);
    await t.focus(t.input()); await t.type(t.input(), "https://example.com/unsafe space"); await t.focus(t.outside);
    expect(t.input().value).toBe("https://example.com/unsafe space"); expect(t.host.querySelectorAll("a")).toHaveLength(0);
    expect(t.host.querySelector('[role="alert"], [role="status"]')).toBeNull();
    t.fail(); await t.focus(t.input()); await t.type(t.input(), "newer draft");
    await t.render("", "older publication"); expect(t.input().value).toBe("newer draft");
    await t.focus(t.outside);
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("Queue unavailable");
    expect(t.input().value).toBe("newer draft");
    await t.focus(t.input()); await t.type(t.input(), "x".repeat(2001)); await t.focus(t.outside);
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("2,000");
    expect(t.input().value.length).toBe(2001);
    expect(t.button("Add Notes, URL, or Attachments")).toBeUndefined();
  } finally { await t.close(); }
});


test("URL idle autosave retains focused editing and follows the latest source baseline", async () => {
  const t = await setup();
  try {
    await t.render("Saved note", "https://example.com");
    await t.focus(t.input());
    jest.useFakeTimers();
    await t.type(t.input(), "autosave.example.com");
    await act(async () => { jest.advanceTimersByTime(3100); });
    jest.useRealTimers();
    expect(t.commits.at(-1)).toEqual(["https://example.com", "https://autosave.example.com"]);
    expect(document.activeElement).toBe(t.input());
    expect(t.input().value).toBe("https://autosave.example.com");
    expect(t.host.querySelector("a")).toBeNull();
    await t.render("Saved note", "https://autosave.example.com");
    await t.type(t.input(), "next.example.com"); await t.focus(t.outside);
    expect(t.commits.at(-1)).toEqual(["https://autosave.example.com", "https://next.example.com"]);
    expect(t.host.querySelector("a")?.textContent).toBe("https://next.example.com");
  } finally {
    jest.useRealTimers();
    await t.close();
  }
});


test("collapsing empty URL extras resets multiple blank rows before reopening", async () => {
  const t = await setup();
  try {
    await t.render("Saved note"); await t.click(t.button("Add URL or Attachments")!);
    await t.focus(t.input()); await t.key(t.input(), "Enter");
    expect(t.host.querySelectorAll("input")).toHaveLength(2);
    expect(document.activeElement).toBe(t.input("URL 2"));
    await t.focus(t.host.querySelector<HTMLTextAreaElement>('[aria-label="Notes"]')!);
    expect(t.host.querySelectorAll("input")).toHaveLength(0);
    expect(t.button("Add URL or Attachments")).toBeDefined();
    await t.click(t.button("Add URL or Attachments")!);
    expect(t.host.querySelectorAll("input")).toHaveLength(1);
    expect(t.input().value).toBe(""); expect(document.activeElement).toBe(t.input());
    expect(t.commits).toEqual([]);
  } finally { await t.close(); }
});
