"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { reassignBeforeDeleting } from "./category-deletion";
import { readTodoJson, type LiveTodo } from "./todo-live";
import { Undo2Icon, Redo2Icon, PencilIcon, MoreHorizontalIcon, PlusIcon, CheckIcon, ArrowLeftIcon, XIcon } from "lucide-react";
import { Alert, Box, Button, Dialog, Field, Flex, IconButton, Input, Menu, Portal, Select, Stack, Text, createListCollection } from "@chakra-ui/react";
import { NestedOverlayContext, useNestedOverlayGuard, useNestedOverlayRegistration } from "@/components/shared/nested-overlay-guard";
import type { components } from "@/lib/generated/quantself-api-schema";
type QueueEdit = (command: components["schemas"]["TodoEdit"], before: LiveTodo) => Promise<void>;

export const categoryColors = { gray: "#8b949e", blue: "#58a6ff", green: "#3fb950", yellow: "#d29922", orange: "#db6d28", red: "#f85149", pink: "#db61a2", purple: "#a371f7" };
export type Color = keyof typeof categoryColors;
export type Category = { id: number; name: string; color: Color; description?: string | null; priority?: number };
type Snapshot = { categories: Category[]; revision: string };
export type CategoryCommand = { action: "create" | "update" | "delete"; id?: number; name?: string; color?: Color };
type CategoryEntry = { localId?: number; id: string; command: CategoryCommand; wire?: object; promise: Promise<Category | undefined>; resolve(value: Category | undefined): void; reject(error: Error): void };
function categoryEntry(command: CategoryCommand): CategoryEntry {
  let resolve!: CategoryEntry["resolve"], reject!: CategoryEntry["reject"];
  const promise = new Promise<Category | undefined>((yes, no) => { resolve = yes; reject = no; });
  return { id: crypto.randomUUID(), command, promise, resolve, reject };
}
type CategoryContextValue = Snapshot & { getCategory(id: number): Category | undefined; waitForWrites(): Promise<void>; queueEdit: QueueEdit; registerQueue(handler: QueueEdit): () => void; error: string; pending: boolean; canRetry: boolean; canUndo: boolean; canRedo: boolean; undo(): void; redo(): void; retry(): Promise<Category | undefined>; refresh(): Promise<void>; change(command: CategoryCommand): Promise<Category | undefined> };
const CategoryContext = createContext<CategoryContextValue>({ getCategory: () => undefined, waitForWrites: async () => {}, queueEdit: () => { throw Error("Task editing unavailable."); }, registerQueue: () => () => {}, categories: [], revision: "", error: "", pending: false, canRetry: false, canUndo: false, canRedo: false, undo: () => {}, redo: () => {}, retry: async () => undefined, refresh: async () => {}, change: async () => undefined });
export const useCategories = () => useContext(CategoryContext);
export function CategoryProvider({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ categories: [], revision: "" });
  const confirmed = useRef(snapshot);
  const accessDenied = useRef(false);
  const generation = useRef(0);
  const queueEdit = useRef<QueueEdit | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const queue = useRef(Promise.resolve());
  const commands = useRef<CategoryEntry[]>([]);
  const saving = useRef(false);
  const undoEntries = useRef<{ before: Category | null; after: Category | null }[]>([]);
  const redoEntries = useRef<{ before: Category | null; after: Category | null }[]>([]);
  const nextLocalId = useRef(-1);
  const aliases = useRef(new Map<number, number>());
  const projected = useRef(snapshot);
  const failed = useRef<CategoryEntry | null>(null);
  function publish() {
    let categories = confirmed.current.categories;
    for (const { command, localId } of commands.current) {
      if (command.action === "update") categories = categories.map(c => c.id === command.id ? { ...c, name: command.name!, color: command.color! } : c);
      else if (command.action === "create") categories = [...categories, { id: localId!, name: command.name!, color: command.color! }];
      else categories = categories.filter(c => c.id !== command.id);
    }
    projected.current = { ...confirmed.current, categories };
    setSnapshot(projected.current);
    setPending(!failed.current && commands.current.length > 0);
  }
  async function refresh() {
    const started = generation.current;
    try {
      const value = await readTodoJson<Snapshot>("/api/v1/todo-categories");
      if (!Array.isArray(value.categories)) throw Error("Categories unavailable.");
      if (!accessDenied.current && started === generation.current && !commands.current.length) { confirmed.current = value; publish(); setError(""); }
    } catch (error) { if (started === generation.current) setError(error instanceof Error ? error.message : "Categories unavailable."); }
  }
  useEffect(() => {
    const denied = () => { accessDenied.current = true; generation.current++; confirmed.current = { categories: [], revision: "" }; for (const entry of commands.current) entry.reject(Error("To-Do access denied.")); commands.current = []; publish(); setError("To-Do access denied."); };
    document.addEventListener("quantself:todos-access-denied", denied);
    return () => document.removeEventListener("quantself:todos-access-denied", denied);
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const visible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    document.addEventListener("quantself:categories-changed", visible);
    const timer = setInterval(visible, 60000);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); document.removeEventListener("quantself:categories-changed", visible); };
  }, [active]);
  function drain() {
    if (saving.current || failed.current) return;
    saving.current = true;
    queue.current = (async () => {
      try {
        while (commands.current.length && !failed.current) {
          const entry = commands.current[0], command = entry.command;
          entry.wire ??= { ...command, commandId: entry.id, revision: confirmed.current.revision };
          const send = async () => {
            const response = await fetch("/api/v1/todo-categories", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(entry.wire), signal: AbortSignal.timeout(30000) });
            const body = await response.json();
            if (!response.ok) throw Object.assign(Error(body.message || "Category save failed."), { status: response.status });
            return body as Snapshot;
          };
          try {
            let result: Snapshot;
            try { result = await send(); }
            catch (error) {
              if ((error as { status?: number }).status && (error as { status: number }).status < 500) throw error;
              result = await send(); // Same ID and payload reconcile uncertain delivery.
            }
            if (accessDenied.current) break;
            generation.current++;
            confirmed.current = result;
            commands.current.shift();
            const saved = result.categories.find(c => command.id ? c.id === command.id : c.name === command.name);
            if (command.action === "create" && saved && entry.localId !== undefined) {
              const oldId = entry.localId;
              aliases.current.set(oldId, saved.id);
              for (const pending of commands.current) {
                if (pending.command.id === oldId) pending.command.id = saved.id;
                if (pending.localId === oldId) pending.localId = saved.id;
              }
              for (const history of [...undoEntries.current, ...redoEntries.current]) {
                if (history.before?.id === oldId) history.before.id = saved.id;
                if (history.after?.id === oldId) history.after.id = saved.id;
              }
            }
            entry.resolve(saved);
          } catch (error) {
            const failure = error as Error & { status?: number };
            if (!failure.status || failure.status >= 500) failed.current = entry;
            else {
              commands.current.shift();
              const rejectedId = command.id ?? entry.localId;
              undoEntries.current = undoEntries.current.filter(e => e.before?.id !== rejectedId && e.after?.id !== rejectedId);
              redoEntries.current = redoEntries.current.filter(e => e.before?.id !== rejectedId && e.after?.id !== rejectedId);
              if (command.action === "create") {
                for (const pending of commands.current.filter(p => p.command.id === rejectedId || p.localId === rejectedId)) pending.reject(Error("The category creation was rejected."));
                commands.current = commands.current.filter(p => p.command.id !== rejectedId && p.localId !== rejectedId);
              }
            }
            setError(failure.message);
            entry.reject(failure);
          }
          publish();
        }
      } finally { saving.current = false; publish(); }
    })();
  }
  function getCategory(id: number) {
    const seen = new Set<number>();
    while (aliases.current.has(id) && !seen.has(id)) { seen.add(id); id = aliases.current.get(id)!; }
    return projected.current.categories.find(category => category.id === id);
  }
  function change(command: CategoryCommand, history = true, restoredId?: number): Promise<Category | undefined> {
    if (failed.current) return Promise.reject(Error("Retry the uncertain category save first."));
    if (accessDenied.current || !confirmed.current.revision) return Promise.reject(Error("Categories unavailable."));
    const before = command.id === undefined ? null : getCategory(command.id) ?? null;
    if (before) command = { ...command, id: before.id };
    if (command.action !== "create" && !before) return Promise.reject(Error("Category no longer exists."));
    if (command.action !== "delete") {
      command = { ...command, name: (command.name ?? before?.name ?? "").trim(), color: command.color ?? before?.color ?? "blue" };
      if (!command.name || command.name.length > 100 || !(command.color! in categoryColors)) return Promise.reject(Error("Invalid category name or color."));
      if (projected.current.categories.some(c => c.id !== command.id && c.name.toLocaleLowerCase() === command.name!.toLocaleLowerCase())) return Promise.reject(Error("A category with this name already exists."));
    }
    generation.current++;
    const entry = categoryEntry(command);
    if (command.action === "create") entry.localId = restoredId ?? nextLocalId.current--;
    if (history) {
      const after = command.action === "delete" ? null : { ...(before ?? {}), id: command.id ?? entry.localId!, name: command.name!, color: command.color! };
      undoEntries.current.push({ before: before ? { ...before } : null, after }); redoEntries.current = [];
    }
    commands.current.push(entry);
    publish(); setError(""); drain();
    return entry.promise;
  }
  function retry() {
    const entry = failed.current;
    if (!entry) return Promise.resolve(undefined);
    // The failed command keeps its original ID/payload; later intent remains queued.
    const next = categoryEntry(entry.command);
    entry.promise = next.promise; entry.resolve = next.resolve; entry.reject = next.reject;
    failed.current = null;
    setError(""); publish(); drain();
    return entry.promise.catch(() => undefined);
  }
  function replay(direction: "undo" | "redo") {
    const source = direction === "undo" ? undoEntries : redoEntries;
    const destination = direction === "undo" ? redoEntries : undoEntries;
    const entry = source.current.pop();
    if (!entry) return;
    destination.current.push(entry);
    const category = direction === "undo" ? entry.before : entry.after;
    const current = direction === "undo" ? entry.after : entry.before;
    if (!category) {
      void change({ action: "delete", id: current!.id }, false).catch(() => {});
    } else if (!current) {
      void change({ action: "create", name: category.name, color: category.color }, false, category.id).catch(() => {});
    } else void change({ action: "update", id: category.id, name: category.name, color: category.color }, false).catch(() => {});
  }
  return <CategoryContext.Provider value={{ ...snapshot, getCategory, waitForWrites: async () => { await queue.current; if (failed.current) throw Error("Retry the uncertain category save before assigning this category."); }, queueEdit: (command, before) => { if (!queueEdit.current) throw Error("Task editing unavailable."); return queueEdit.current(command, before); }, registerQueue: handler => { queueEdit.current = handler; return () => { if (queueEdit.current === handler) queueEdit.current = null; }; }, error, pending, canRetry: !!failed.current, refresh, change, canUndo: !!undoEntries.current.length && !failed.current, canRedo: !!redoEntries.current.length && !failed.current, undo: () => replay("undo"), redo: () => replay("redo"), retry }}>{children}</CategoryContext.Provider>;
}
export function categoryStyle(color?: Color): CSSProperties {
  const accent = categoryColors[color ?? "gray"];
  return { "--event-accent": accent, "--event-fill": `color-mix(in srgb, ${accent} 18%, var(--chakra-colors-bg))`, "--event-ink": `color-mix(in srgb, ${accent} 65%, var(--chakra-colors-fg))` } as CSSProperties;
}
const NO_CATEGORY = "__none";
const NEW_CATEGORY = "__create";
const MANAGE_CATEGORIES = "__manage";

type CategoryOption = { value: string; label: string; color?: Color };
const uncategorized = { value: NO_CATEGORY, label: "Uncategorized", color: "gray" } satisfies CategoryOption;

function CategoryDot({ color, size = "2.5", rounded = "sm" }: { color: Color; size?: string; rounded?: string }) {
  return <Box as="span" aria-hidden="true" boxSize={size} flexShrink={0} rounded={rounded} bg={categoryColors[color]} />;
}

function CategoryOptions({ options, label, aligned = false, portalled = true }: { options: CategoryOption[]; label: string; aligned?: boolean; portalled?: boolean }) {
  return <Portal disabled={!portalled}>
    <Select.Positioner>
      <Select.Content aria-label={label} minW="36" maxW="calc(100dvw - 16px)"
        maxH={aligned ? "min(24rem, calc(100dvh - 16px))" : "min(24rem, var(--available-height, calc(100dvh - 16px)))"}
        p="1" gap="0" bg="bg.panel" color="fg" rounded="lg" shadow="md" borderWidth="1px">
        {options.map(option => <Select.Item item={option} key={option.value} h="7" py="0" px="2" fontSize="sm" cursor="default">
          {option.color && <CategoryDot color={option.color} />}
          <Select.ItemText truncate>{option.label}</Select.ItemText>
          <Select.ItemIndicator />
        </Select.Item>)}
      </Select.Content>
    </Select.Positioner>
  </Portal>;
}

export function CategoryPicker({ value, onChange, disabled = false, id, compact = false }: { value: string; onChange(value: string): void; disabled?: boolean; id?: string; compact?: boolean }) {
  const { categories } = useCategories();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "manage" | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const selectOpen = open && !disabled;
  useNestedOverlayRegistration(selectOpen);
  useEffect(() => { if (disabled) { setOpen(false); setMode(null); } }, [disabled]);

  const options = useMemo<CategoryOption[]>(() => [
    uncategorized,
    ...(value && !categories.some(c => c.name === value) ? [{ value: `category:${value}`, label: value }] : []),
    ...categories.map(c => ({ value: `category:${c.name}`, label: c.name, color: c.color })),
    { value: NEW_CATEGORY, label: "+ New category" },
    { value: MANAGE_CATEGORIES, label: "Manage categories" },
  ], [categories, value]);
  const collection = useMemo(() => createListCollection({ items: options }), [options]);
  const selected = value ? `category:${value}` : NO_CATEGORY;
  const selectedIndex = options.findIndex(option => option.value === selected);

  return <>
    <Select.Root
      size="sm" variant={compact ? "ghost" : "outline"} w="fit" maxW="full" flexShrink={compact ? 0 : undefined}
      collection={collection} value={[selected]} ids={id ? { trigger: id } : undefined}
      open={selectOpen} present={selectOpen} immediate disabled={disabled} onOpenChange={next => setOpen(next.open && !disabled)}
      positioning={compact
        ? { sameWidth: false, placement: "bottom-end", gutter: 4 }
        // Align the selected 28px row with the 32px trigger; let the panel slide at screen edges.
        : { sameWidth: false, placement: "bottom-start", flip: false, overlap: true, gutter: -(21 + selectedIndex * 28 + 14) }}
      onValueChange={({ value: [next] }) => {
        if (!next || disabledRef.current) return;
        if (next === NEW_CATEGORY) setMode("create");
        else if (next === MANAGE_CATEGORIES) setMode("manage");
        else onChange(next === NO_CATEGORY ? "" : next.slice("category:".length));
      }}
    >
      <Select.Control>
        <Select.Trigger ref={trigger} aria-label="Category" title={value || "Uncategorized"}
          minH={compact ? "7" : "8"} px={compact ? "1.5" : "2.5"} gap="1.5" rounded={compact ? "md" : "lg"}
          _hover={compact ? { bg: "bg.muted" } : undefined}
        >
          {compact
            ? <CategoryDot size="3" rounded="3px" color={options[selectedIndex]?.color ?? "gray"} />
            : <Select.ValueText maxW="none" truncate placeholder="Uncategorized" />}
          <Select.Indicator opacity={compact ? 0.55 : 1} flexShrink={0} />
        </Select.Trigger>
      </Select.Control>
      <CategoryOptions options={options} label="Category" aligned={!compact} />
    </Select.Root>
    {mode && !disabled && <CategoryManager mode={mode} onClose={() => setMode(null)} finalFocusEl={() => trigger.current} onCreated={c => { if (!disabledRef.current) onChange(c.name); setMode(null); }} />}
  </>;
}

function CategoryDeleteMenu({ name, onDelete }: { name: string; onDelete(): void }) {
  const [open, setOpen] = useState(false);
  useNestedOverlayRegistration(open);
  return <Menu.Root lazyMount unmountOnExit open={open} onOpenChange={event => setOpen(event.open)} positioning={{ placement: "bottom-end", strategy: "fixed", hideWhenDetached: true }}>
    <Menu.Trigger asChild><IconButton variant="ghost" size="xs" aria-label={`Options for ${name}`}><MoreHorizontalIcon /></IconButton></Menu.Trigger>
    <Menu.Positioner>
      <Menu.Content><Menu.Item value="delete" color="fg.error" onSelect={onDelete}>Delete category</Menu.Item></Menu.Content>
    </Menu.Positioner>
  </Menu.Root>;
}

export function CategoryManager({ mode, onClose, onCreated, finalFocusEl }: { mode: "create" | "manage"; onClose(): void; onCreated(c: Category): void; finalFocusEl?: () => HTMLElement | null }) {
  const categories = useCategories();
  const [page, setPage] = useState<"list" | "edit" | "create" | "delete">(mode === "create" ? "create" : "list");
  const [selected, setSelected] = useState<Category | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<Color>("blue");
  const [target, setTarget] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const [affected, setAffected] = useState<LiveTodo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(0);
  useEffect(() => () => { operation.current++; }, []);
  function back() { operation.current++; setPage("list"); setBusy(false); setError(""); }
  async function save() {
    if (busy || !name.trim()) return;
    const version = ++operation.current;
    const creating = page === "create";
    setBusy(creating); setError("");
    if (!creating) setPage("list");
    try {
      const result = await categories.change({ action: creating ? "create" : "update", ...(!creating ? { id: selected!.id } : {}), name: name.trim(), color });
      if (version !== operation.current) return;
      if (creating && result) { if (mode === "create") onCreated(result); else setPage("list"); }
    } catch (error) { if (version === operation.current) { setError((error as Error).message); setPage(creating ? "create" : "edit"); } }
    finally { if (version === operation.current) setBusy(false); }
  }
  async function prepareDelete(category: Category) {
    const version = ++operation.current;
    setSelected(category); setPage("delete"); setAffected(null); setTarget(""); setError("");
    try {
      await categories.waitForWrites();
      const { todos } = await readTodoJson<{ todos: LiveTodo[] }>("/api/v1/todos?trash=include");
      if (version === operation.current) setAffected(todos.filter(todo => todo.categoryId === category.id || todo.fields.Category === category.name));
    } catch (error) { if (version === operation.current) setError((error as Error).message); }
  }
  async function remove() {
    if (!selected || !affected || busy) return;
    const version = ++operation.current;
    setBusy(true); setError("");
    try {
      await reassignBeforeDeleting(affected, todo => categories.queueEdit({ commandId: crypto.randomUUID(), fields: { Category: { before: todo.fields.Category ?? null, after: target === "__none" ? null : target } } }, todo), () => categories.change({ action: "delete", id: selected.id }), () => version === operation.current);
      if (version === operation.current) back();
    } catch (error) { if (version === operation.current) { setError((error as Error).message); setAffected(null); } }
    finally { if (version === operation.current) setBusy(false); }
  }
  const title = page === "list" ? "Manage categories" : page === "create" ? "New category" : page === "edit" ? "Edit category" : `Delete ${selected?.name}?`;
  const content = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const moveOptions = useMemo<CategoryOption[]>(() => [uncategorized, ...categories.categories
    .filter(c => c.id !== selected?.id)
    .map(c => ({ value: c.name, label: c.name, color: c.color }))], [categories.categories, selected?.id]);
  const moveCollection = useMemo(() => createListCollection({ items: moveOptions }), [moveOptions]);
  useNestedOverlayRegistration(true);
  const nested = useNestedOverlayGuard();

  return <Dialog.Root open placement="center" size="xs" scrollBehavior="inside" initialFocusEl={() => mode === "manage" ? content.current : nameInput.current}
    finalFocusEl={finalFocusEl} onOpenChange={({ open }) => { if (!open) { operation.current++; onClose(); } }}
    onInteractOutside={event => { if (nested.protect()) event.preventDefault(); }}
    onEscapeKeyDown={event => { if (nested.protect()) event.preventDefault(); }}>
    <Portal>
      <Dialog.Backdrop bg="blackAlpha.100" backdropFilter="blur(2px)" />
      <Dialog.Positioner px="4">
        <Dialog.Content ref={content} maxH="85dvh" rounded="xl" bg="bg.panel" borderWidth="1px" color="fg">
          <Dialog.Header p="4" pb="0">
            <Dialog.Title display="flex" alignItems="center" gap="2" fontSize="md" fontWeight="medium" pe="8">
              {page !== "list" && mode === "manage" && <IconButton variant="ghost" size="xs" aria-label="Back to categories" onClick={back}><ArrowLeftIcon /></IconButton>}{title}
            </Dialog.Title>
            <Dialog.Description srOnly>Manage task category names and colors.</Dialog.Description>
          </Dialog.Header>
          <Dialog.Body p="4">
            <NestedOverlayContext.Provider value={nested.registry}>
            <Stack gap="4">
              {page === "list" && <>
                <Stack gap="0" divideY="1px" rounded="xl" borderWidth="1px" bg="bg.muted/20">
                  {categories.categories.map(c => <Flex key={c.id} align="center" gap="3" px="3" py="2">
                    <CategoryDot color={c.color} size="3" rounded="full" />
                    <Text minW="0" flex="1" truncate>{c.name}</Text>
                    <IconButton variant="ghost" size="xs" aria-label={`Edit ${c.name}`} onClick={() => { operation.current++; setSelected(c); setName(c.name); setColor(c.color); setError(""); setPage("edit"); }}><PencilIcon /></IconButton>
                    <CategoryDeleteMenu name={c.name} onDelete={() => void prepareDelete(c)} />
                  </Flex>)}
                </Stack>
                <Flex align="center" justify="space-between">
                  <Button variant="outline" size="sm" onClick={() => { operation.current++; setSelected(null); setName(""); setColor("blue"); setError(""); setPage("create"); }}><PlusIcon />New category</Button>
                  {(categories.canUndo || categories.canRedo) && <Flex>
                    <IconButton variant="ghost" size="xs" aria-label="Undo category change" disabled={!categories.canUndo} onClick={categories.undo}><Undo2Icon /></IconButton>
                    <IconButton variant="ghost" size="xs" aria-label="Redo category change" disabled={!categories.canRedo} onClick={categories.redo}><Redo2Icon /></IconButton>
                  </Flex>}
                </Flex>
              </>}
              {(page === "create" || page === "edit") && <form onSubmit={e => { e.preventDefault(); void save(); }}>
                <Stack gap="4">
                  <Field.Root>
                    <Field.Label htmlFor="category-name">Name</Field.Label>
                    <Input ref={nameInput} autoFocus id="category-name" size="sm" maxLength={100} value={name} onChange={e => setName(e.target.value)} />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label as="div">Color</Field.Label>
                    <Flex wrap="wrap" gap="2" role="group" aria-label="Category color">
                      {Object.entries(categoryColors).map(([value, hex]) => <IconButton variant="plain" type="button" key={value} aria-label={value} aria-pressed={color === value} onClick={() => setColor(value as Color)}
                        size="xs" rounded="full" borderWidth="1px" borderColor="blackAlpha.200" outlineOffset="4px" bg={hex} color="white">
                        {color === value && <CheckIcon style={{ filter: "drop-shadow(0 1px 1px #0004)" }} />}
                      </IconButton>)}
                    </Flex>
                  </Field.Root>
                  <Flex justify="end" gap="2">
                    <Button type="button" size="sm" variant="ghost" onClick={mode === "create" ? onClose : back}>Cancel</Button>
                    <Button type="submit" size="sm" disabled={busy || !name.trim() || !categories.revision}>{busy ? "Creating…" : page === "edit" ? "Save" : "Create category"}</Button>
                  </Flex>
                </Stack>
              </form>}
              {page === "delete" && <Stack gap="4">
                {affected === null ? <Text color="fg.muted" role="status">{error ? "Category kept." : "Checking tasks…"}</Text> : affected.length ? <>
                  <Text>{affected.length} {affected.length === 1 ? "task uses" : "tasks use"} {selected?.name}. Move {affected.length === 1 ? "it" : "them"} to:</Text>
                  <Select.Root collection={moveCollection} size="sm" w="fit" maxW="full" value={target ? [target] : []} onValueChange={({ value }) => setTarget(value[0] ?? "")}
                    open={moveOpen && !busy} onOpenChange={event => setMoveOpen(event.open && !busy)}
                    disabled={busy} positioning={{ sameWidth: false, strategy: "fixed", hideWhenDetached: true, placement: "bottom-start" }}>
                    <MoveSelectRegistration open={moveOpen && !busy} />
                    <Select.Control>
                      <Select.Trigger aria-label="Move tasks to" gap="2"><Select.ValueText placeholder="Choose category" /><Select.Indicator flexShrink={0} /></Select.Trigger>
                    </Select.Control>
                    <CategoryOptions options={moveOptions} label="Move tasks to" portalled={false} />
                  </Select.Root>
                </> : <Text>No tasks use this category.</Text>}
                <Flex justify="end" gap="2">
                  <Button variant="ghost" size="sm" onClick={back}>Cancel</Button>
                  {affected === null && error
                    ? <Button size="sm" onClick={() => selected && void prepareDelete(selected)}>Check again</Button>
                    : <Button colorPalette="red" size="sm" disabled={busy || affected === null || (!!affected.length && !target)} onClick={() => void remove()}>{busy ? "Saving…" : affected?.length ? "Move & delete" : "Delete category"}</Button>}
                </Flex>
              </Stack>}
              {(error || categories.error) && <Alert.Root role="alert" status="error" size="sm"><Alert.Content><Alert.Description>{error || categories.error}{categories.canRetry && <Button variant="ghost" size="sm" onClick={() => { setError(""); void categories.retry(); }}>Retry save</Button>}</Alert.Description></Alert.Content></Alert.Root>}
            </Stack>
            </NestedOverlayContext.Provider>
          </Dialog.Body>
          <Dialog.CloseTrigger asChild><IconButton variant="ghost" size="xs" aria-label="Close"><XIcon /></IconButton></Dialog.CloseTrigger>
        </Dialog.Content>
      </Dialog.Positioner>
    </Portal>
  </Dialog.Root>;
}

function MoveSelectRegistration({ open }: { open: boolean }) {
  useNestedOverlayRegistration(open);
  return null;
}
