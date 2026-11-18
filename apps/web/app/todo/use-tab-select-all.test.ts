import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bindTabSelectAll } from "./use-tab-select-all";

test("Tab and Shift+Tab select text; mouse, native controls, readonly and external portals retain selection", () => {
  const dom = new Window();
  const keys = ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: (dom as any)[key] });
  const surface = dom.document.createElement("div");
  surface.innerHTML = '<input value="Client"><textarea>Task title</textarea><input type="number" value="15"><input type="checkbox"><input type="date"><input type="time"><select><option>One</option></select><input readonly value="Readonly"><div contenteditable="true" role="textbox">Notes</div>';
  dom.document.body.append(surface);
  const outside = dom.document.createElement("input"); outside.value = "Portal search"; dom.document.body.append(outside);
  const unbind = bindTabSelectAll(surface as unknown as HTMLElement);
  const tab = (shiftKey = false) => dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
  try {
    const input = surface.querySelector("input")!;
    input.setSelectionRange(2, 2); input.focus();
    expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(2);
    input.blur(); tab(); input.focus();
    expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
    const title = surface.querySelector("textarea")!;
    tab(true); title.focus(); expect(title.selectionStart).toBe(0); expect(title.selectionEnd).toBe(title.value.length);
    input.setSelectionRange(3, 3); tab(); dom.document.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true })); input.focus();
    expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(3);
    for (const native of surface.querySelectorAll('input[type="checkbox"], input[type="date"], input[type="time"], select, input[readonly]')) {
      let selected = false; Object.defineProperty(native, "select", { configurable: true, value: () => { selected = true; } });
      tab(); (native as any).focus(); expect(selected).toBe(false);
    }
    const number = surface.querySelector('input[type="number"]')! as any;
    let numberSelected = false;
    number.select = () => { numberSelected = true; };
    tab(); number.focus(); expect(numberSelected).toBe(true);
    let selectedNotes = 0;
    const notes = surface.querySelector('[contenteditable]')! as any;
    notes.editor = { isEditable: true, commands: { selectAll: () => { selectedNotes++; } } };
    tab(); notes.focus(); expect(selectedNotes).toBe(1);
    notes.blur(); notes.editor.isEditable = false; tab(); notes.focus(); expect(selectedNotes).toBe(1);
    outside.setSelectionRange(2, 2); tab(); outside.focus(); expect(outside.selectionStart).toBe(2); expect(outside.selectionEnd).toBe(2);
    unbind(); input.blur(); input.setSelectionRange(1, 1); tab(); input.focus(); expect(input.selectionStart).toBe(1);
  } finally {
    unbind(); dom.happyDOM.abort();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
