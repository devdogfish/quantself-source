import { afterAll, expect, jest, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import type { Editor } from "@tiptap/react";

mock.module("./jarvis-ui", () => ({ useJarvisDraft: () => {} }));
afterAll(() => mock.restore());

test("notes render Markdown, retain untouched source, format with shortcuts and autosave against current optimistic source", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  Object.defineProperty(dom.navigator, "platform", { value: "MacIntel" });
  const keys = ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "DOMParser", "DocumentFragment", "NodeFilter", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "getComputedStyle", "getSelection", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as any)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "getSelection", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom) : value });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoNotesEditor } = await import("./todo-notes-editor");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const commits: string[][] = [];
  let setSource!: (value: string) => void;
  let deferPublication = false;
  let rejectCommit = false;
  let setReadonly!: (value: boolean) => void;
  const original = "__Bold__ and [Library](https://example.com)\n\n- First\n- Second";
  function Harness() {
    const [value, setValue] = useState(original); setSource = setValue;
    const [readOnly, setReadOnly] = useState(false); setReadonly = setReadOnly;
    return <TodoNotesEditor value={value} readOnly={readOnly} onCommit={(before, after) => { if (rejectCommit) throw new Error("Queue unavailable"); commits.push([before, after]); if (!deferPublication) setValue(after); }} />;
  }
  try {
    await act(async () => root.render(<ChakraTestWrapper><Harness /></ChakraTestWrapper>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    jest.useFakeTimers();
    const textbox = host.querySelector<HTMLElement>('[role="textbox"]')!;
    const editor = (textbox as HTMLElement & { editor: Editor }).editor;
    expect(textbox.querySelector("strong")?.textContent).toBe("Bold");
    expect(textbox.querySelectorAll("ul li")).toHaveLength(2);
    expect(textbox.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    await act(async () => { textbox.focus(); textbox.blur(); });
    expect(commits).toHaveLength(0); // Opening/focusing must not normalize and rewrite Markdown.
    const { bindTabSelectAll } = await import("./use-tab-select-all");
    const unbindSelection = bindTabSelectAll(host);
    await act(async () => {
      editor.commands.setTextSelection(2);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      textbox.focus();
    });
    expect(editor.state.selection.from).toBe(0);
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
    expect(commits).toHaveLength(0);
    await act(async () => textbox.blur());
    unbindSelection();
    await act(async () => editor.commands.setContent("Plain", { contentType: "markdown" }));
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 6 }); textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", metaKey: true, bubbles: true, cancelable: true })); });
    expect(editor.getMarkdown()).toBe("**Plain**");
    expect(textbox.querySelector("strong")?.textContent).toBe("Plain");
    await act(async () => { jest.advanceTimersByTime(3100); });
    expect(commits).toEqual([[original, "**Plain**"]]);
    // A commit can precede the queue's optimistic publication. Clearing dirty
    // must not reapply the unchanged source prop and visibly erase the edit.
    deferPublication = true;
    await act(async () => { textbox.focus(); editor.commands.setContent("Deferred notes", { contentType: "markdown" }); });
    await act(async () => textbox.blur());
    expect(editor.getMarkdown()).toBe("Deferred notes");
    expect(commits.at(-1)).toEqual(["**Plain**", "Deferred notes"]);
    await act(async () => setSource("Deferred notes"));
    expect(editor.getMarkdown()).toBe("Deferred notes");
    deferPublication = false;
    // A rejected queue operation retains the draft and exposes a retryable error.
    rejectCommit = true;
    await act(async () => { textbox.focus(); editor.commands.setContent("Retry notes", { contentType: "markdown" }); });
    await act(async () => textbox.blur());
    expect(editor.getMarkdown()).toBe("Retry notes");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Queue unavailable");
    rejectCommit = false;
    await act(async () => { textbox.focus(); textbox.blur(); });
    expect(commits.at(-1)).toEqual(["Deferred notes", "Retry notes"]);
    // Authoritative rollback remains visible after the optimistic source changed.
    await act(async () => setSource("Deferred notes"));
    expect(editor.getMarkdown()).toBe("Deferred notes");
    // Undo through shared task history replaces a clean document, even while focused.
    await act(async () => { textbox.focus(); setSource("Undone source"); });
    expect(editor.getMarkdown()).toBe("Undone source");
    await act(async () => editor.commands.insertContentAt(editor.state.doc.content.size - 1, " later"));
    await act(async () => textbox.blur());
    expect(commits.at(-1)).toEqual(["Undone source", "Undone source later"]);
    // Older source updates cannot erase an uncommitted draft.
    await act(async () => editor.commands.insertContentAt(editor.state.doc.content.size - 1, " draft"));
    await act(async () => setSource("Earlier response"));
    expect(editor.getMarkdown()).toBe("Undone source later draft");
    await act(async () => textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(editor.getMarkdown()).toBe("Earlier response"); expect(commits).toHaveLength(4);
    // Use the library's actual typing rules, not a custom Markdown formatter.
    const key = (key: string) => textbox.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const type = (text: string) => {
      for (const character of text) {
        const { view } = editor;
        const { from, to } = view.state.selection;
        const handled = view.someProp("handleTextInput", handler => handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)));
        if (!handled) view.dispatch(view.state.tr.insertText(character));
      }
    };
    const typeMarkdown = async (text: string) => act(async () => {
      editor.commands.setContent("", { contentType: "markdown" });
      editor.commands.setTextSelection(1);
      type(text);
    });
    await typeMarkdown("- item"); expect(editor.getJSON().content?.[0]?.type).toBe("bulletList");
    await act(async () => { key("Enter"); key("Enter"); type("after list"); });
    expect(editor.getJSON().content?.[1]?.type).toBe("paragraph");
    await typeMarkdown("1. item"); expect(editor.getJSON().content?.[0]?.type).toBe("orderedList");
    await typeMarkdown("**typed**"); expect(textbox.querySelector("strong")?.textContent).toBe("typed");
    await typeMarkdown("`inline`"); expect(textbox.querySelector("code")?.textContent).toBe("inline");
    await typeMarkdown("### Heading");
    await act(async () => { key("Enter"); type("normal"); });
    expect(textbox.querySelector("h3")?.textContent).toBe("Heading");
    expect(editor.getJSON().content?.[1]?.type).toBe("paragraph");
    await typeMarkdown("> quote");
    await act(async () => { key("Enter"); key("Enter"); type("after quote"); });
    expect(editor.getJSON().content?.[1]?.type).toBe("paragraph");
    await typeMarkdown("``` ");
    expect(editor.getJSON().content?.[0]?.type).toBe("codeBlock");
    await act(async () => { type("code"); key("Enter"); key("Enter"); key("Enter"); type("- item"); });
    expect(editor.getJSON().content?.[1]?.type).toBe("bulletList");
    // The Markdown extension parses commands, but does not provide a paste handler.
    await typeMarkdown("");
    const paste = (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "", files: [] } });
      textbox.dispatchEvent(event);
    };
    await act(async () => paste("## Pasted\n\n- one\n- two\n\n`literal`"));
    expect(textbox.querySelector("h2")?.textContent).toBe("Pasted");
    expect(textbox.querySelectorAll("ul li")).toHaveLength(2);
    expect(textbox.querySelector("code")?.textContent).toBe("literal");
    await typeMarkdown("``` ");
    await act(async () => paste("**literal code**"));
    expect(textbox.querySelector("strong")).toBeNull();
    await typeMarkdown("\\*literal\\*");
    expect(textbox.querySelector("em")).toBeNull();
    const beforeComposition = commits.length;
    await act(async () => {
      textbox.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      editor.commands.insertContent(" composing");
      textbox.focus(); textbox.blur();
    });
    expect(commits).toHaveLength(beforeComposition);
    await act(async () => {
      textbox.dispatchEvent(new Event("compositionend", { bubbles: true }));
      textbox.focus(); textbox.blur();
    });
    expect(commits).toHaveLength(beforeComposition + 1);
    const savedSelection = editor.state.selection.from;
    await act(async () => setSource(commits.at(-1)![1]));
    expect(editor.state.selection.from).toBe(savedSelection);
    await act(async () => setReadonly(true));
    expect(textbox.getAttribute("contenteditable")).toBe("false"); expect(textbox.getAttribute("aria-readonly")).toBe("true");
  } finally {
    jest.useRealTimers();
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}, 15000);
