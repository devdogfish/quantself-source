import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Editor, JSONContent } from "@tiptap/react";
mock.module("./jarvis-ui", () => ({ useJarvisDraft: () => {} }));
afterAll(() => mock.restore());

test("notes keyboard editing nests lists, handles boundaries, and preserves table and paragraph navigation", async () => {
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
  const { ResumeMarkdownShortcuts } = await import("../jobs/review/resume-markdown-shortcuts");
  const extensions = [ResumeMarkdownShortcuts];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const commits: string[][] = [];
  const original = "- Parent\n- Child";
  try {
    await act(async () => root.render(<ChakraTestWrapper><TodoNotesEditor value={original} readOnly={false} extensions={extensions} markdownEditing onCommit={(before, after) => commits.push([before, after])} /></ChakraTestWrapper>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const textbox = host.querySelector<HTMLElement>('[role="textbox"]')!;
    const editor = (textbox as HTMLElement & { editor: Editor }).editor;
    const json = (): JSONContent => editor.getJSON();
    const { bindTabSelectAll } = await import("./use-tab-select-all");
    const unbind = bindTabSelectAll(host);
    const caret = (text: string, end = false) => {
      let position: number | undefined;
      editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === text) position = pos + (end ? text.length : 0); });
      if (position === undefined) throw Error(`Missing text: ${text}`);
      editor.commands.setTextSelection(position);
      textbox.focus();
    };
    const key = async (key: string, options: KeyboardEventInit = {}, target: Element = textbox) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
      await act(async () => { target.dispatchEvent(event); target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, ...options })); });
      return event;
    };
    const reset = async (markdown: string, at: string, end = false) => act(async () => {
      editor.commands.setContent(markdown, { contentType: "markdown" }); caret(at, end);
    });
    try {
      const globalShortcuts: string[] = [];
      const observeGlobal = (event: KeyboardEvent) => { if (event.metaKey || event.ctrlKey) globalShortcuts.push(event.key); };
      window.addEventListener("keydown", observeGlobal);
      await reset("Formatting", "Formatting");
      await act(async () => editor.commands.selectAll());
      await key("b", { metaKey: true }, textbox.querySelector("p")!);
      expect(editor.isActive("bold")).toBe(true);
      await key("i", { metaKey: true });
      expect(editor.isActive("italic")).toBe(true);
      await key("z", { metaKey: true });
      expect(editor.isActive("italic")).toBe(false);
      await key("b", { ctrlKey: true });
      expect(globalShortcuts).toEqual([]);
      await key("b", { ctrlKey: true }, host);
      expect(globalShortcuts).toEqual(["b"]);
      window.removeEventListener("keydown", observeGlobal);
      await reset(original, "Child");
      await act(async () => caret("Child"));
      expect((await key("Tab")).defaultPrevented).toBe(true);
      expect(textbox.querySelector("ul > li > ul > li")?.textContent).toBe("Child");
      expect(document.activeElement).toBe(textbox);
      const nested = editor.getMarkdown();
      await act(async () => textbox.blur());
      expect(commits).toEqual([[original, nested]]);
      await reset(nested, "Child");
      expect(textbox.querySelector("ul > li > ul > li")?.textContent).toBe("Child");
      expect((await key("Tab", { shiftKey: true })).defaultPrevented).toBe(true);
      expect(textbox.querySelectorAll("ul > li > ul")).toHaveLength(0);
      expect(textbox.querySelectorAll("ul > li")).toHaveLength(2);

      for (const [markdown, listType, itemType] of [
        ["- First\n- Second", "bulletList", "listItem"],
        ["1. First\n2. Second", "orderedList", "listItem"],
        ["- [x] First\n- [ ] Second", "taskList", "taskItem"],
      ]) {
        await reset(markdown!, "Second");
        expect((await key("Tab")).defaultPrevented).toBe(true);
        const first = json().content?.[0]?.content?.[0];
        expect(first?.type).toBe(itemType);
        expect(first?.content?.[1]?.type).toBe(listType);
        expect(first?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Second");
        if (itemType === "taskItem") {
          expect(first?.attrs?.checked).toBe(true);
          expect(first?.content?.[1]?.content?.[0]?.attrs?.checked).toBe(false);
        }
        const nestedDocument = json();
        await reset(editor.getMarkdown(), "Second");
        expect(json()).toEqual(nestedDocument);
        await key("Tab", { shiftKey: true });
        expect(json().content?.[0]?.content).toHaveLength(2);
        await act(async () => caret("First"));
        const before = json();
        expect((await key("Tab")).defaultPrevented).toBe(true); // Cannot nest without an earlier sibling.
        expect(json()).toEqual(before);
        expect((await key("Tab", { shiftKey: true })).defaultPrevented).toBe(true);
        expect(json().content?.[0]?.type).toBe("paragraph");
      }
      await reset("- First\n- Second", "Second", true);
      await key("Enter"); await key("Enter");
      expect(json().content?.at(-1)?.type).toBe("paragraph");
      await reset("- First\n  - Second", "Second");
      await key("Backspace");
      expect(json().content?.[0]?.content).toHaveLength(2);
      expect(json().content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("Second");
      // A selection spanning sibling items nests and outdents as one operation.
      await reset("- First\n- Second\n- Third", "Second");
      const from = editor.state.selection.from;
      await act(async () => { caret("Third", true); editor.commands.setTextSelection({ from, to: editor.state.selection.to }); });
      await key("Tab");
      expect(json().content?.[0]?.content?.[0]?.content?.[1]?.content).toHaveLength(2);
      await key("Tab", { shiftKey: true });
      expect(json().content?.[0]?.content).toHaveLength(3);
      await reset("- First\n\nParagraph", "Paragraph");
      expect((await key("Tab")).defaultPrevented).toBe(false);
      expect((await key("Tab", { shiftKey: true })).defaultPrevented).toBe(false);
      expect(json().content?.[1]?.type).toBe("paragraph");
      await reset("| Header A | Header B |\n| --- | --- |\n| Cell A | Cell B |", "Cell A");
      expect((await key("Tab")).defaultPrevented).toBe(true);
      expect(editor.state.selection.$from.parent.textContent).toBe("Cell B");
      await key("Tab", { shiftKey: true });
      expect(editor.state.selection.$from.parent.textContent).toBe("Cell A");
      await reset("```\ncode\n```", "code");
      expect((await key("Tab")).defaultPrevented).toBe(true);
      expect(editor.state.doc.textContent.trim()).toBe("code");
      expect(editor.state.doc.textContent.length).toBeGreaterThan(4);
      await key("Tab", { shiftKey: true });
      expect(editor.state.doc.textContent).toBe("code");
      await reset("- First\n- Second", "Second");
      const composing = json();
      await key("Tab", { isComposing: true });
      expect(json()).toEqual(composing);
      await reset("- First\n- **Second**\n- Third", "Second");
      expect((await key("l", { metaKey: true })).defaultPrevented).toBe(true);
      expect(editor.getMarkdown()).toContain("- [ ] **Second**");
      expect(editor.state.selection.$from.parent.textContent).toBe("Second");
      const mixedList = json();
      await reset(editor.getMarkdown(), "Second");
      expect(json()).toEqual(mixedList);
      await key("l", { metaKey: true });
      expect(editor.getMarkdown()).toContain("- [x] **Second**");
      await key("L", { metaKey: true, shiftKey: true, keyCode: 76 } as KeyboardEventInit);
      expect(editor.getMarkdown()).toBe("- First\n- **Second**\n- Third");

      await reset("- First\n- **Second**\n  - Nested\n- Third", "Second", true);
      const beforeArrange = json();
      const selectedText = () => editor.state.selection.$from.parent.textContent;
      expect((await key("ArrowUp", { altKey: true })).defaultPrevented).toBe(true);
      expect(textbox.querySelector("li")?.textContent).toBe("SecondNested");
      expect(selectedText()).toBe("Second");
      await key("ArrowDown", { altKey: true });
      expect(json()).toEqual(beforeArrange);
      await key("ArrowDown", { altKey: true, shiftKey: true });
      expect(textbox.querySelectorAll("li ul li")).toHaveLength(2);
      expect(selectedText()).toBe("Second");
      await key("z", { metaKey: true });
      expect(json()).toEqual(beforeArrange);

      for (const [left, right] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ['"', '"'], ["`", "`"]]) {
        await reset("**Selected**", "Selected");
        const from = editor.state.selection.from;
        await act(async () => editor.commands.setTextSelection({ from, to: from + "Selected".length }));
        expect((await key(left!)).defaultPrevented).toBe(true);
        const selected = editor.state.selection;
        expect(editor.state.doc.textContent).toBe(`${left}Selected${right}`);
        expect(editor.state.doc.textBetween(selected.from, selected.to)).toBe("Selected");
        expect(editor.isActive("bold")).toBe(true);
      }

      await reset("Selected", "Selected");
      await act(async () => editor.commands.selectAll());
      await key("<");
      expect(editor.getMarkdown()).toBe("&lt;Selected&gt;");

      await reset("**Selected**", "Selected");
      await act(async () => editor.commands.selectAll());
      Object.defineProperty(dom, "prompt", { value: () => "https://example.com/project_(demo)?a=1&b=2" });
      expect((await key("k", { metaKey: true })).defaultPrevented).toBe(true);
      expect(textbox.querySelector("a strong")?.textContent).toBe("Selected");
      expect(editor.getMarkdown()).toBe("[**Selected**](https://example.com/project_(demo)?a=1&b=2)");
      await act(async () => textbox.blur());
      expect(commits.at(-1)?.[1]).toBe(editor.getMarkdown());

      const unfinishedLink = "Source [Site](https://example.com";
      await act(async () => {
        editor.commands.setContent({ type: "paragraph", content: [{ type: "text", text: unfinishedLink }] });
        caret(unfinishedLink, true);
      });
      const at = editor.state.selection.from;
      await act(async () => editor.view.someProp("handleTextInput", handler => handler(editor.view, at, at, ")", () => editor.state.tr.insertText(")"))));
      expect(textbox.querySelector("a")?.textContent).toBe("Site");
      expect(editor.getMarkdown()).toBe("Source [Site](https://example.com)");

      const linked = "See [Site](https://example.com) today";
      await reset(linked, "Site");
      expect(textbox.textContent).toBe(linked);
      expect(editor.getMarkdown()).toBe(linked);
      await act(async () => caret(" today", true));
      expect(textbox.textContent).toBe("See Site today");
      await act(async () => { caret("Site"); textbox.blur(); });
      expect(textbox.textContent).toBe("See Site today");

      await act(async () => textbox.focus());
      const sourceShortcut = { code: "Period", metaKey: true, shiftKey: true };
      expect((await key(">", sourceShortcut)).defaultPrevented).toBe(true);
      const source = host.querySelector("textarea")!;
      expect(source.value).toBe(linked);
      expect(document.activeElement).toBe(source);
      const revisedSource = "See [Site](https://example.com/new) _today_.";
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(source, revisedSource);
        source.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await key(">", sourceShortcut, source);
      expect(host.querySelector("textarea")).toBeNull();
      expect(document.activeElement).toBe(textbox);
      expect(textbox.querySelector("a")?.href).toBe("https://example.com/new");
      expect(textbox.querySelector("em")?.textContent).toBe("today");
      expect(commits.at(-1)?.[1]).toBe(revisedSource);

      await act(async () => root.render(<ChakraTestWrapper><TodoNotesEditor value={original} readOnly extensions={extensions} markdownEditing onCommit={() => { throw Error("Readonly notes changed"); }} /></ChakraTestWrapper>));
      const readonly = json();
      await key("Tab"); await key("Tab", { shiftKey: true });
      await key("l", { metaKey: true }); await key("k", { metaKey: true });
      expect(json()).toEqual(readonly);
    } finally { unbind(); }
  } finally {
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}, 15000);
