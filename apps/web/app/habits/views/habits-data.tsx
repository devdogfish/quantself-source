"use client";
// Shared route-lifetime data and optimistic commands. Fixture code loads only in preview.
import { projectCatalogFact } from "../../../../api/src/habits-catalog-facts";
import type { CatalogFact } from "../../../../api/src/habits-insights-schema";
import { usePathname } from "next/navigation";
import type { HabitSummary } from "../../../../api/src/habits-summary-core";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { habitStore } from "../habits-api";
import { habitToday, type Occurrence } from "../habit-store";
import { toaster } from "@/components/chakra/toaster";
import { DAYS, type Ask, type Habit, type Stack, type State } from "./habit-metrics";
import { habitDates, projectHabits, readHabits, readHabitSummary, readHabitAsks, sendHabitAsk, type LiveSnapshot } from "./habits-live-data";

type LiveAsk = import("../../../../api/src/habits-ask-schema").HabitAskListRecord;
type AskResult = import("../../../../api/src/habits-ask-schema").HabitAskRecord;
const projectAsk = (a: LiveAsk): Ask => ({ id: a.id, outcomeRevision: a.outcomeRevision, date: a.date, at: a.at, habit: a.habitId, feeling: a.feeling, outcome: a.outcome === "open" ? "unknown" : a.outcome, day: a.date === habitToday() ? "Today" : new Date(`${a.date}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", day: "numeric" }) });

type CatalogData = { stacks: Stack[]; habits: Habit[]; hist: Record<string, State[]>; dates: Date[]; today: Date; catalogFacts?: CatalogFact[] };
export type HabitsData = CatalogData & {
  ask: (input: { habitId: string; text: string }, id: string) => Promise<AskResult>; asksLoading: boolean; asksError: string | null;
  summary: HabitSummary | null; facts: Record<string, ReturnType<typeof projectCatalogFact>>; build: Habit[]; asks: Ask[]; stub: boolean; loading: boolean; error: string | null;
  set: (habitId: string, dayIndex: number, state: State) => void;
  undo: () => void; redo: () => void; retry: () => void;
};
const Ctx = createContext<HabitsData | null>(null);
const empty = (): CatalogData => ({ stacks: [], habits: [], hist: {}, dates: habitDates(habitToday()), today: new Date(`${habitToday()}T12:00:00`) });
export function HabitsDataProvider({ children, fixture = process.env.NEXT_PUBLIC_QUANTSELF_HABITS_FIXTURE === "1", read = readHabits, store = habitStore }: {
  children: React.ReactNode; fixture?: boolean; read?: () => Promise<LiveSnapshot>; store?: typeof habitStore;
}) {
  const pathname = usePathname();
  const summaryPage = pathname === "/habits/summary", askPage = pathname === "/habits/ask";
  const [asksReload, setAsksReload] = useState(0);
  const [asksLoading, setAsksLoading] = useState(false);
  const [asksError, setAsksError] = useState<string | null>(null);
  const askFlight = useRef<ReturnType<typeof readHabitAsks> | null>(null);
  const localAsks = useRef(new Map<string, LiveAsk>());
  const [summary, setSummary] = useState<HabitSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryReload, setSummaryReload] = useState(0);
  const summaryFlight = useRef<{ key: string; promise: Promise<HabitSummary> } | null>(null);
  const fixtureSummary = useRef<((hist: CatalogData["hist"]) => HabitSummary) | null>(null);
  const loaded = useRef<{ read: typeof read; fixture: boolean; reload: number } | null>(null);
  const [base, setBase] = useState<CatalogData>(empty);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<LiveSnapshot> | null>(null);
  const version = useSyncExternalStore(store.subscribe, store.snapshot, () => 0);
  const fixtureUndo = useRef<CatalogData["hist"][]>([]), fixtureRedo = useRef<CatalogData["hist"][]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!fixture && summaryPage) return;
    if (loaded.current?.read === read && loaded.current.fixture === fixture && loaded.current.reload === reload) return;
    let alive = true;
    setLoading(true);
    setError(null);
    const load = async () => {
      if (fixture) {
        const sample = await import("./stub-data");
        if (alive) { fixtureSummary.current = sample.summaryFor; setBase({ habits: sample.habits, stacks: sample.stacks, hist: sample.initialHistory(), dates: sample.dates, today: sample.TODAY }); setAsks(sample.asks); loaded.current = { read, fixture, reload }; }
      } else {
        // Strict Mode reuses the same request; navigation keeps this layout mounted.
        inflight.current ??= read();
        const snapshot = await inflight.current;
        if (alive) { store.merge(snapshot.day.occurrences); setBase(projectHabits(snapshot)); loaded.current = { read, fixture, reload }; }
      }
    };
    void load().catch(e => { if (alive) setError(e instanceof Error ? e.message : "Habits unavailable."); })
      .finally(() => { if (alive) { inflight.current = null; setLoading(false); } });
    return () => { alive = false; };
  }, [fixture, read, store, reload, summaryPage]);
  useEffect(() => {
    if (fixture || !askPage) return;
    let alive = true; setAsksLoading(true); setAsksError(null);
    askFlight.current ??= readHabitAsks();
    const flight = askFlight.current;
    void flight.then(rows => {
      if (!alive) return;
      const merged = new Map(rows.map(r => [r.id, r]));
      // A deferred analytics read must not erase an ask returned since it began.
      for (const [id, row] of localAsks.current) {
        if (row.date < new Date(Date.parse(habitToday()) - 13 * 86400000).toISOString().slice(0, 10)) { localAsks.current.delete(id); continue; }
        const remote = merged.get(id);
        if (!remote) merged.set(id, row);
        else merged.set(id, (remote.outcomeRevision ?? -1) >= (row.outcomeRevision ?? -1) ? { ...row, outcome: remote.outcome, outcomeRevision: remote.outcomeRevision } : row);
      }
      setAsks([...merged.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).map(projectAsk));
    }).catch(e => { if (alive) setAsksError(e instanceof Error ? e.message : "Habit asks unavailable."); })
      .finally(() => { if (askFlight.current === flight) askFlight.current = null; if (alive) setAsksLoading(false); });
    return () => { alive = false; };
  }, [fixture, askPage, asksReload]);
  const pending = store.pending();
  useEffect(() => {
    if (fixture || !summaryPage || (pending && summary)) return;
    let alive = true;
    setSummaryLoading(true); setSummaryError(null);
    const key = `${summaryReload}/${pending ? "pending" : version}`;
    if (summaryFlight.current?.key !== key) summaryFlight.current = { key, promise: readHabitSummary() };
    void summaryFlight.current.promise.then(result => { if (alive) setSummary(result); })
      .catch(e => { if (alive) setSummaryError(e instanceof Error ? e.message : "Habit Summary unavailable."); })
      .finally(() => { if (alive) { summaryFlight.current = null; setSummaryLoading(false); } });
    return () => { alive = false; };
    // Coalesce all command acknowledgements into one refresh after the queue drains.
    // `summary` and individual queue versions must not trigger read loops.
  }, [fixture, summaryPage, summaryReload, pending]);
  const value = useMemo<HabitsData>(() => {
    const hist = { ...base.hist };
    if (!fixture) {
      for (const row of store.rowsForDate(habitToday())) {
        if (!hist[row.habitId]) continue;
        const current = store.row(row);
        hist[row.habitId] = [...hist[row.habitId]!];
        hist[row.habitId]![DAYS - 1] = current.missed ? "missed" : current.status;
      }
    }
    const undo = () => {
      if (!fixture) return store.undo();
      const prev = fixtureUndo.current.pop();
      if (prev) { fixtureRedo.current.push(base.hist); setBase({ ...base, hist: prev }); }
    };
    const redo = () => {
      if (!fixture) return store.redo();
      const next = fixtureRedo.current.pop();
      if (next) { fixtureUndo.current.push(base.hist); setBase({ ...base, hist: next }); }
    };
    const facts = Object.fromEntries((base.catalogFacts ?? []).map(f => [f.id, projectCatalogFact(f, hist[f.id]?.at(-1) ?? f.today)]));
    const askRows = new Map([...new Set(asks.flatMap(a => a.date ? [a.date] : []))].map(date => [date, new Map(store.rowsForDate(date).map(row => [row.habitId, row]))]));
    const currentAsks = asks.map(a => {
      if (fixture || !a.date) return a;
      const row = askRows.get(a.date)?.get(a.habit);
      if (!row || !store.pending(row) && row.revision < (a.outcomeRevision ?? 0)) return a;
      const status = store.row(row).status;
      return { ...a, outcome: status === "done" ? "did full" as const : status === "minimum" ? "did minimum" as const : status === "skipped" ? "skipped" as const : "unknown" as const };
    });
    return { ...base, asksLoading, asksError, ask: async (input, id) => {
      const result = await sendHabitAsk(input, id);
      localAsks.current.set(result.id, result);
      setAsks(previous => [projectAsk(result), ...previous.filter(a => a.id !== result.id)]);
      return result;
    }, summary: fixture ? fixtureSummary.current?.(hist) ?? null : summary, hist, facts, asks: currentAsks, build: base.habits.filter(h => h.kind === "build" && !h.untracked), stub: fixture, loading: !fixture && summaryPage ? summaryLoading && !summary : loading, error: !fixture && summaryPage ? summaryError : error,
      undo, redo, retry: () => { store.retry(); if (summaryPage && summaryError) setSummaryReload(n => n + 1); else if (asksError) setAsksReload(n => n + 1); else if (error) setReload(n => n + 1); },
      set: (id, i, state) => {
        if (!hist[id] || !["done", "minimum", "skipped", "open"].includes(state)) return;
        if (fixture) {
          fixtureUndo.current.push(base.hist); fixtureRedo.current = [];
          setBase({ ...base, hist: { ...base.hist, [id]: base.hist[id]!.map((s, j) => j === i ? state : s) } });
        } else {
          const date = base.dates[i];
          if (!date) return;
          const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
          const row = store.rowsForDate(local).find(r => r.habitId === id);
          if (row) store.edit(row, { status: state as Occurrence["status"], note: store.row(row).note });
        }
      },
    };
  }, [base, asks, fixture, loading, error, store, version, summary, summaryPage, summaryLoading, summaryError, asksLoading, asksError]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.target instanceof Element && e.target.closest("input,textarea,[contenteditable=true]"))) return;
      if (e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? value.redo() : value.undo(); }
      else if (e.key.toLowerCase() === "y") { e.preventDefault(); value.redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [value]);
  const saveErrors = store.errors().join("\n");
  useEffect(() => {
    if (saveErrors) toaster.create({ id: "habit-save-error", type: "error", title: saveErrors, duration: Infinity,
      action: { label: "Retry", onClick: store.retry } });
    else toaster.dismiss("habit-save-error");
  }, [saveErrors, store]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useHabitsData() {
  const value = useContext(Ctx);
  if (!value) throw Error("HabitsDataProvider missing");
  return value;
}
