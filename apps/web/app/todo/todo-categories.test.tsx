import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

test.each(["success", "uncertain"])("category edits and Undo/Redo preserve later intent during deferred %s saves", async mode => {
  const dom = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let release!: () => void;
  let releaseRead!: () => void;
  const commands: any[] = [];
  let reads = 0;
  let revision = 1;
  let categories = [{ id: 1, name: "Work", color: "blue" }];
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (_path: string, init?: RequestInit) => {
      if (!init?.method) { reads++; const result = Response.json({ categories, revision: String(revision) }); if (reads === 2) await new Promise<void>(resolve => { releaseRead = resolve; }); return result; }
      const command = JSON.parse(String(init.body)); commands.push(command);
      await new Promise<void>(resolve => { release = resolve; });
      if (mode === "uncertain" && commands.length <= 2) throw Error("Response lost");
      expect(command.revision).toBe(String(revision));
      categories = categories.map(c => c.id === command.id ? { ...c, name: command.name, color: command.color } : c); revision++;
      return Response.json({ categories, revision: String(revision) });
    } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const { CategoryProvider, useCategories } = await import("./todo-categories");
  const root = createRoot(host);
  function Harness() {
    const c = useCategories();
    return <><button onClick={c.retry}>Retry</button><button onClick={() => void c.refresh()}>Refresh</button><output>{c.categories.map(v => `${v.name}:${v.color}`).join(",")}</output><button onClick={() => void c.change({ action: "update", id: 1, name: "Studio", color: "pink" }).catch(() => {})}>First</button><button onClick={() => void c.change({ action: "update", id: 1, name: "Projects", color: "green" })}>Second</button><button onClick={c.undo} disabled={!c.canUndo}>Undo</button><button onClick={c.redo} disabled={!c.canRedo}>Redo</button></>;
  }
  const click = (text: string) => act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click());
  const shown = () => host.querySelector("output")!.textContent;
  try {
    await act(async () => root.render(<CategoryProvider><Harness /></CategoryProvider>));
    expect(shown()).toBe("Work:blue");
    await click("Refresh");
    const started = performance.now();
    await click("First");
    expect(shown()).toBe("Studio:pink");
    console.log(`Category rename optimistic render: ${(performance.now() - started).toFixed(2)}ms; response still deferred.`);
    await click("Second"); expect(shown()).toBe("Projects:green");
    await click("Undo"); expect(shown()).toBe("Studio:pink");
    await click("Redo"); expect(shown()).toBe("Projects:green");
    expect(commands).toHaveLength(1);
    if (mode === "uncertain") {
      await act(async () => release()); await act(async () => release());
      expect(commands).toHaveLength(2); expect(shown()).toBe("Projects:green");
      await click("Retry"); expect(commands[2]).toEqual(commands[0]);
    }
    for (let index = 0; index < 4; index++) { await act(async () => release()); expect(shown()).toBe("Projects:green"); }
    expect(commands).toHaveLength(mode === "uncertain" ? 6 : 4); expect(reads).toBe(2);
    await act(async () => releaseRead()); expect(shown()).toBe("Projects:green");
    expect(new Set(commands.map(c => c.commandId)).size).toBe(4);
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});

test.each(["rejected", "denied", "uncertain"])("category %s saves reconcile visibly and preserve retry identity", async mode => {
  const dom = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const commands: any[] = [];
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (_path: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ categories: [{ id: 1, name: "Work", color: "blue" }], revision: "r1" });
      commands.push(JSON.parse(String(init.body)));
      if (mode !== "uncertain") return Response.json({ message: "Category edit rejected." }, { status: mode === "denied" ? 403 : 409 });
      if (commands.length <= 2) throw Error("Delivery uncertain");
      return Response.json({ categories: [{ id: 1, name: "Studio", color: "pink" }], revision: "r2" });
    } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const { CategoryProvider, useCategories } = await import("./todo-categories");
  const root = createRoot(host);
  function Harness() {
    const c = useCategories();
    return <><output>{c.categories.map(v => v.name).join(",")}</output><p role="alert">{c.error}</p><button onClick={() => void c.change({ action: "update", id: 1, name: "Studio", color: "pink" }).catch(() => {})}>Rename</button><button onClick={c.retry}>Retry</button></>;
  }
  try {
    await act(async () => root.render(<CategoryProvider><Harness /></CategoryProvider>));
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Rename")!.click());
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(mode !== "uncertain" ? "Category edit rejected." : "Delivery uncertain");
    expect(host.querySelector("output")!.textContent).toBe(mode !== "uncertain" ? "Work" : "Studio");
    if (mode === "uncertain") {
      await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Retry")!.click());
      expect(commands).toHaveLength(3);
      expect(commands[1]).toEqual(commands[0]); expect(commands[2]).toEqual(commands[0]);
      expect(host.querySelector("output")!.textContent).toBe("Studio");
      expect(host.querySelector('[role="alert"]')!.textContent).toBe("");
    } else {
      expect(commands).toHaveLength(1);
      await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Rename")!.click());
      expect(commands).toHaveLength(2); // Definite refusal must not lock later edits as uncertain.
    }
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});

test("category create/delete and Undo/Redo project immediately and rebind server IDs without stale resurrection", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "ResizeObserver", "DocumentFragment", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let release!: () => void, id = 10, revision = 1;
  const commands: any[] = [];
  let categories: any[] = [];
  for (const name of names) {
    const value = name === "window" ? dom : name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "fetch" ? async (_path: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ categories, revision: String(revision) });
      const command = JSON.parse(String(init.body)); commands.push(command);
      await new Promise<void>(resolve => { release = resolve; });
      expect(command.revision).toBe(String(revision));
      if (command.action === "create") categories.push({ id: id++, name: command.name, color: command.color });
      else if (command.action === "delete") { expect(command.id).toBeGreaterThan(0); categories = categories.filter(c => c.id !== command.id); }
      else categories = categories.map(c => c.id === command.id ? { ...c, name: command.name, color: command.color } : c);
      revision++;
      return Response.json({ categories, revision: String(revision) });
    } : (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? value.bind(dom) : value });
  }
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const { CategoryProvider, useCategories } = await import("./todo-categories");
  const root = createRoot(host);
  function Harness() {
    const c = useCategories();
    return <><output>{c.categories.map(v => `${v.id}:${v.name}`).join(",")}</output><button onClick={() => void c.change({ action: "create", name: "Garden", color: "green" })}>Create</button><button onClick={() => void c.change({ action: "delete", id: c.categories[0].id })}>Delete</button><button onClick={() => { void c.change({ action: "update", id: c.categories[0].id, name: "Herbs" }); void c.change({ action: "update", id: c.categories[0].id, color: "red" }); }}>Burst</button><button onClick={c.undo} disabled={!c.canUndo}>Undo</button><button onClick={c.redo} disabled={!c.canRedo}>Redo</button></>;
  }
  const click = (text: string) => act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click());
  const shown = () => host.querySelector("output")!.textContent;
  try {
    await act(async () => root.render(<CategoryProvider><Harness /></CategoryProvider>));
    await click("Create"); expect(shown()).toBe("-1:Garden");
    await click("Undo"); expect(shown()).toBe("");
    await click("Redo"); expect(shown()).toBe("-1:Garden");
    expect(commands).toHaveLength(1);
    await act(async () => release()); expect(shown()).toBe("10:Garden");
    await act(async () => release()); expect(shown()).toBe("10:Garden");
    await act(async () => release()); expect(shown()).toBe("11:Garden");
    await click("Delete"); expect(shown()).toBe("");
    await click("Undo"); expect(shown()).toBe("11:Garden");
    await act(async () => release()); expect(shown()).toBe("11:Garden");
    await act(async () => release()); expect(shown()).toBe("12:Garden");
    await click("Redo"); expect(shown()).toBe("");
    await act(async () => release()); expect(shown()).toBe("");
    expect(commands.map(c => c.action)).toEqual(["create", "delete", "create", "delete", "create", "delete"]);
    expect(commands.filter(c => c.action === "delete").map(c => c.id)).toEqual([10, 11, 12]);
    await click("Create"); await act(async () => release());
    await click("Burst"); expect(shown()).toContain(":Herbs");
    await act(async () => release()); expect(shown()).toContain(":Herbs");
    expect(commands.at(-1)).toMatchObject({ name: "Herbs", color: "red" });
    await act(async () => release());
    expect(categories[0]).toMatchObject({ name: "Herbs", color: "red" });
  } finally {
    await act(async () => root.unmount()); await dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
