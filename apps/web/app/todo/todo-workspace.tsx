"use client";

import { AnimatePresence } from "motion/react";
import { useJarvisCategoryCommands } from "./jarvis-category-commands";
import { useJarvisTaskContext } from "./use-jarvis-task-context";
import { TodoSuggestions } from "./todo-suggestions";
import { todoHistory, type HistoryDirection } from "./todo-history";
import { useSharedTaskWorkspace, useTaskWorkspaceQueue, type OrderEdit, type TimingEdit } from "./task-workspace-queue";

import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import type { components } from "@/lib/generated/quantself-api-schema";

import { Button, CloseButton, Dialog, Drawer, Field, Input, Kbd, Portal, SegmentGroup, Spinner, Stack } from "@chakra-ui/react";
import u from "./todo-workspace-controls.module.css";
import s from "./todo-workspace.module.css";
import { CalendarTopBar, type CalendarView } from "../calendar/calendar-top-bar";

import { saveTodoFacts } from "./todo-facts-editor";
import { readTodoJson, TodoBrowserError, type LiveTodo } from "./todo-live";
import { CategoryProvider, CategoryManager, useCategories } from "./todo-categories";
import { CategoryFilter } from "./category-filter";
import { NewTaskPopover } from "./new-task-popover";
import { newTaskTiming } from "./new-task-timing";
import { TodoDetail } from "./todo-detail";
import { NativeAppointmentDetail, NativeAppointmentSaveNotice } from "./native-appointment-detail";
import { NativeAppointmentList } from "./native-appointment-list";
import { NativeAppointmentQueueProvider } from "./native-appointment-queue";
import { appointmentId, type NativeAppointment } from "./native-appointments";
import type { DelegateControls } from "./todo-delegate-picker";
import { projectTodoDelegate } from "./todo-delegate-queue";
import { projectTodoDecision } from "./todo-decision-queue";
import { ReturnHandBackDialog, type DecisionControls } from "./todo-handback";
import { reconciledCategoryFilter, useJarvisUi, type JarvisUiAction, type JarvisCalendarView } from "./jarvis-ui";
import { moveTaskTiming, resizeTaskTiming, taskTiming, localDateTime, timingInstant, type TaskTiming } from "./todo-timing";

import { todoTask, todosForDate, type Task } from "./todo-projection";

import { isTaskLinkControl, today, minute, time, shiftDate, shiftMonth, dateLabel, useCalendarClock, type Actions } from "./task-workspace-context";
import { TodoSpaceBar, TodoViews, useTodoLayout } from "./views/todo-space";
import type { ViewActions } from "./views/view-model";
import { toaster } from "@/components/chakra/toaster";
export type CalendarSurfaceProps = {
  hasHabits: boolean;
  hasSubscriptions: boolean;
  hasNativeAppointments: boolean;
  hasMeetings: boolean;
  canCancelMeetings: boolean;
  openAppointment: (appointment: NativeAppointment) => void;
  subscribeTasks: (listener: () => void) => () => void;
  date: string;
  view: Exclude<CalendarView, "list">;
  todayScrollRequest: number;
  onCurrentTimeVisibilityChange: (value: { rangeKey: string; visible: boolean }) => void;
  actionsForDate: (date: string) => Actions;
  navigate: (date: string, view?: CalendarView) => void;
};
type WorkspaceProps = { CalendarSurface?: React.ComponentType<CalendarSurfaceProps> };

export function TodoWorkspace(props: WorkspaceProps) {
  const shared = useSharedTaskWorkspace();
  const workspace = <TodoWorkspaceContent {...props} />;
  return shared ? workspace : <NativeAppointmentQueueProvider><CategoryProvider>{workspace}</CategoryProvider></NativeAppointmentQueueProvider>;
}

function TodoWorkspaceContent({ CalendarSurface }: WorkspaceProps) {
  const { queue, status: queueStatus, live: rawLive } = useTaskWorkspaceQueue();
  const delegates = useSyncExternalStore(queue.delegates.subscribe, queue.delegates.getSnapshot, queue.delegates.getSnapshot);
  const decisions = useSyncExternalStore(queue.decisions.subscribe, queue.decisions.getSnapshot, queue.decisions.getSnapshot);
  const [returning, setReturning] = useState<LiveTodo | null>(null);
  const categories = useCategories();
  const [categoryFilter, setCategoryFilter] = useState("__all");
  const [managingCategories, setManagingCategories] = useState(false);
  const previousCategories = useRef(categories.categories);
  useEffect(() => {
    if (categories.revision) setCategoryFilter(reconciledCategoryFilter(categoryFilter, previousCategories.current, categories.categories));
    previousCategories.current = categories.categories;
  }, [categories.revision, categories.categories, categoryFilter]);
  const categoryById = useMemo(() => new Map(categories.categories.map(c => [c.id, c])), [categories.categories]);
  const categoryByName = useMemo(() => new Map(categories.categories.map(c => [c.name, c])), [categories.categories]);
  const allTodos = useMemo(() => rawLive.todos.map(source => {
    const todo = projectTodoDelegate(projectTodoDecision(source, decisions), delegates);
    const category = todo.categoryId ? categoryById.get(todo.categoryId) : categoryByName.get(String(todo.fields.Category));
    return category && category.name !== todo.fields.Category ? { ...todo, fields: { ...todo.fields, Category: category.name } } : todo;
  }), [rawLive.todos, delegates, decisions, categoryById, categoryByName]);
  const live = { ...rawLive, todos: allTodos };
  const lifecycleTodos = [...allTodos, ...(rawLive.trashTodos ?? [])];
  const visibleTodos = useMemo(() => allTodos.filter(todo => categoryFilter === "__all" || (categoryFilter === "__none" ? !todo.fields.Category : todo.fields.Category === categoryById.get(Number(categoryFilter))?.name)), [allTodos, categoryFilter, categoryById]);
  const history = useSyncExternalStore(todoHistory.subscribe, todoHistory.getSnapshot, todoHistory.getSnapshot);
  const { orderLock, editSequence, orderQueue, orderPaused, timingLock, timingQueue, timingPaused, copyQueue, copyLock, copyPaused } = queue;
  const { orderMessage, pendingOrder, clipboard, timingMessage, timingPending, savingTiming, copyPending } = queueStatus;
  const [canApprove, setCanApprove] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [canReadTodos, setCanReadTodos] = useState(false);
  const [ownerSession, setOwnerSession] = useState(false);
  const [canReadHabits, setCanReadHabits] = useState(false);
  const [canReadBudget, setCanReadBudget] = useState(false);
  const [canReadMeetings, setCanReadMeetings] = useState(false);
  const [canCancelMeetings, setCanCancelMeetings] = useState(false);
  const [canReadJobs, setCanReadJobs] = useState<boolean | null>(null);
  const [canWriteJobs, setCanWriteJobs] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creationTiming, setCreationTiming] = useState<{ start: string; end: string; allDay: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    void readTodoJson<{ permissions: string[]; client?: { kind: string } }>(
      "/api/v1/access-context",
      controller.signal,
    )
      .then((access) => {
        setCanWrite(access.permissions?.includes("todos:write") ?? false);
        setCanReadTodos(access.permissions?.includes("todos:read") ?? false);
        setOwnerSession(access.client?.kind === "web");
        setCanReadHabits(access.permissions?.includes("habits:read") ?? false);
        setCanReadBudget(access.permissions?.includes("budgeting:read") ?? false);
        setCanReadMeetings(access.permissions?.includes("meetings:read") ?? false);
        setCanCancelMeetings(access.permissions?.includes("meetings:write") ?? false);
        setCanReadJobs(access.permissions?.includes("jobs:read") ?? false);
        setCanWriteJobs(access.permissions?.includes("jobs:write") ?? false);
        setCanApprove(access.permissions?.includes("todos:approve") ?? false);
      })
      .catch(() => { if (!controller.signal.aborted) { setCanWrite(false); setCanReadJobs(false); } });
    return () => controller.abort();
  }, []);
  const writable = canWrite && ["ready", "empty"].includes(live.status);
  const decisionControls: DecisionControls = {
    available: ownerSession && writable && !history.replaying,
    busy: todo => !!decisions.get(todo.id)?.pending || !!delegates.entries.get(todo.id)?.pending,
    decide(todo, action) {
      if (!ownerSession || !writable) return;
      const current = live.todos.find(task => task.id === todo.id) ?? todo;
      if (current.delegation?.revision !== todo.delegation?.revision) {
        queue.set("orderMessage", "The hand-back changed. Review the latest hand-back.");
        return;
      }
      const apply = queue.decisions.decide(current, action, () => { void rawLive.refreshAfterWrite(); });
      if (apply) todoHistory.recordLocal({ key: todo.id, apply });
    },
    returnToAgent: setReturning,
    resume: todo => queue.decisions.resume(todo, () => { void rawLive.refreshAfterWrite(); }),
  };
  const delegateControls: DelegateControls = {
    available: ownerSession && writable && !history.replaying,
    directory: delegates,
    load: () => void queue.delegates.loadAgents(),
    change(todo, after) {
      if (decisionControls.busy(todo) || todo.delegation?.pendingDecision) return;
      const before = projectTodoDelegate(todo, queue.delegates.getSnapshot()).delegation?.delegate ?? null;
      const reconcile = () => { void rawLive.refreshAfterWrite(); };
      try {
        if (!queue.delegates.change(todo, before, after, reconcile)) return;
        todoHistory.recordLocal({ key: todo.id, apply(direction) {
          if (direction === "undo") queue.delegates.change(todo, after, before, reconcile);
          else queue.delegates.change(todo, before, after, reconcile);
        } });
      } catch (error) {
        queue.set("orderMessage", error instanceof Error ? error.message : "Could not change the delegate.");
        reconcile();
      }
    },
  };
  const clock = useCalendarClock();
  const currentDate = clock.date || today;
  const clockLabel = clock.label || undefined;
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const nativeId = appointmentId(params.get("appointment"));
  const [appointmentPreview, setAppointmentPreview] = useState<NativeAppointment>();
  const hasNativeAppointments = canReadJobs === true && (categoryFilter === "__all" || categoryById.get(Number(categoryFilter))?.name === "Job search");
  const setAppointmentQuery = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) {
      next.delete("task");
      next.set("appointment", id);
    } else next.delete("appointment");
    window.history.replaceState(null, "", next.size ? `${pathname}?${next}` : pathname);
  };
  const openAppointment = (appointment: NativeAppointment) => {
    setDetailNumber(null);
    setAppointmentPreview(appointment);
    setAppointmentQuery(appointment.id);
  };
  const closeAppointment = () => {
    setAppointmentPreview(undefined);
    setAppointmentQuery(null);
  };
  const requestedDate = params.get("date");
  const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && !Number.isNaN(Date.parse(requestedDate)) ? requestedDate : currentDate;
  const requestedView = params.get("view");
  const view: CalendarView = !CalendarSurface ? "list" : requestedView === "week" || requestedView === "month" || requestedView === "year" || requestedView === "list" ? requestedView : "calendar";
  const space = view === "list";
  const [layout, setLayout] = useTodoLayout();
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [createdEventId, setCreatedEventId] = useState<string | null>(null);
  useEffect(() => { if (!adding) setCreatedEventId(null); }, [adding]);
  useEffect(() => {
    const deselectOutsideEvent = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || isTaskLinkControl(target) || target.closest('[data-calendar-event], [role="menu"], [role="dialog"]')) return;
      setSelectedEvent(null);
      // Blank calendar space also releases the old event's keyboard target.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest("[data-calendar-event]")) focused.blur();
    };
    document.addEventListener("click", deselectOutsideEvent, true);
    return () => document.removeEventListener("click", deselectOutsideEvent, true);
  }, []);
  const [detailNumber, setDetailNumber] = useState<number | null>(null);
  const detailEventId = detailNumber === null ? undefined : live.todos.find(todo => todo.number === detailNumber)?.id;
  useEffect(() => { if (detailEventId) setSelectedEvent(detailEventId); }, [detailEventId]);
  const [utility, setUtility] = useState<"date" | "search" | "shortcuts" | "planning" | "trash" | null>(null);
  const [statusPreview, setStatusPreview] = useState<"automatic" | "loading" | "offline" | "online">("automatic");
  const [searchText, setSearchText] = useState("");
  const [todayScrollRequest, setTodayScrollRequest] = useState(0);
  const [currentTimeVisibility, setCurrentTimeVisibility] = useState({ rangeKey: "", visible: false });
  const [jumpDate, setJumpDate] = useState(date);
  const navigate = (nextDate: string, nextView: CalendarView = view) => {
    setSelectedEvent(null);
    if (pathname === "/calendar" && nextView === "list" && view !== "list") {
      router.push(`/todo?date=${nextDate}`);
      return;
    }
    if (!CalendarSurface && nextView !== "list") {
      router.push(`/calendar?${new URLSearchParams({ view: nextView, date: nextDate })}` as Route);
      return;
    }
    // Calendar state is entirely client-side. Next integrates native history
    // updates with useSearchParams without fetching/caching another server tree.
    window.history.replaceState(null, "", `${pathname}?${new URLSearchParams({ view: nextView, date: nextDate })}`);
  };
  const goToday = () => { setTodayScrollRequest((value) => value + 1); navigate(currentDate, view === "year" ? "calendar" : view); };
  const periodDate = (direction: number) => view === "year" ? shiftMonth(date, direction * 12) : view === "month" ? shiftMonth(date, direction) : shiftDate(date, direction * (view === "week" ? 7 : 1));
  const navigatePeriod = (direction: number) => navigate(periodDate(direction));
  const records = visibleTodos.map(todoTask);
  const priorities = live.todos.filter((todo) => todo.fields["Top priority"] === "Yes").map((todo) => todo.id);
  function enqueueChanges(edits: OrderEdit[], replay = false) {
    if (!writable || history.replaying || !edits.length) { for (const edit of edits) edit.settled?.reject(Error("Task editing unavailable.")); return; }
    if (replay) for (const edit of edits) {
      if (edit.command.trash || edit.command.deadlineAt) {
        const todo = lifecycleTodos.find(todo => todo.number === edit.number);
        if (!todo) throw Error("Task no longer available. Refresh before restoring this change.");
        edit.command.revision = todo.updatedAt;
      }
      if (edit.command.start !== undefined) {
        const todo = lifecycleTodos.find(todo => todo.number === edit.number);
        if (!todo || JSON.stringify(taskTiming(todo)) !== JSON.stringify(edit.expectedTiming)) throw Error("This event changed since your edit. Review its current time first.");
        edit.command.revision = todo.updatedAt;
      }
    }
    if (!replay) todoHistory.recordChanges(edits);
    for (const edit of edits) {
      edit.sequence = ++editSequence.current;
      orderQueue.current.push(edit);
      live.edits.start(edit.command.commandId, edit.number, edit.command);
    }
    queue.set("timingMessage", "");
    queue.set("orderMessage", "Saving changes…");
    void persistOrder();
  }
  async function persistOrder(retry = false) {
    if (!writable || orderLock.current || timingLock.current || (orderPaused.current && !retry)) return;
    orderPaused.current = false;
    orderLock.current = true;
    queue.set("pendingOrder", []);
    const messages: string[] = [];
    const discard = (edit: OrderEdit, message: string) => {
      todoHistory.discardChanges(edit.number);
      if (edit.command.start !== undefined) todoHistory.discardTiming(edit.number);
      for (const pending of orderQueue.current.filter(item => item.number === edit.number)) { live.edits.fail(pending.command.commandId, message, true); pending.settled?.reject(Error(message)); }
      orderQueue.current = orderQueue.current.filter(item => item.number !== edit.number);
    };
    try {
      while (orderQueue.current.length) {
        if ((timingQueue.current[0]?.sequence ?? Infinity) < (orderQueue.current[0].sequence ?? Infinity)) break;
        const edit = orderQueue.current[0];
        try {
          if (edit.command.fields?.Category) await categories.waitForWrites();
          const result = await saveTodoFacts(edit.number, edit.command, { replay: true });
          live.edits.finish(edit.command.commandId, result);
          messages.push(`#${edit.number}: ${Object.entries(result.outcomes).map(([key, value]) => `${key} ${value}`).join(", ")}`);
          if (result.retryable) { edit.settled?.reject(Error("Task move needs retry. Retry the task save before deleting this category.")); orderPaused.current = true; queue.set("pendingOrder", [...orderQueue.current]); break; }
          if (Object.values(result.outcomes).some(value => value !== "saved")) discard(edit, result.message);
          else { orderQueue.current.shift(); edit.settled?.resolve(); }
          const nextChange = orderQueue.current.find(item => item.number === edit.number);
          if (nextChange && result.todo && (nextChange.command.start !== undefined || nextChange.command.trash || nextChange.command.deadlineAt)) nextChange.command.revision = result.todo.updatedAt;
          const nextTiming = timingQueue.current.find(item => item.number === edit.number);
          if (nextTiming && result.todo) nextTiming.command.revision = result.todo.updatedAt;
          if (!result.todo) await live.refreshAfterWrite();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Save unavailable.";
          const rejected = error instanceof TodoBrowserError && [400, 401, 403, 404, 409, 422].includes(error.status);
          live.edits.fail(edit.command.commandId, message, rejected);
          messages.push(message);
          if (rejected) { discard(edit, message); await live.refreshAfterWrite(); }
          else { edit.settled?.reject(Error(message)); orderPaused.current = true; queue.set("pendingOrder", [...orderQueue.current]); break; }
        }
      }
    } finally {
      queue.set("orderMessage", messages.join(" · "));
      orderLock.current = false;
      if (timingQueue.current.length) void persistTiming();
    }
  }
  function togglePriority(id: string) {
    const todo = live.todos.find(todo => todo.id === id);
    if (!todo) return;
    const selected = todo.fields["Top priority"] === "Yes";
    if (!selected && priorities.length >= 3) { queue.set("orderMessage", "Choose at most three current top priorities. Remove a selection first."); return; }
    enqueueChanges([{number: todo.number, command: {commandId: crypto.randomUUID(), fields: {"Top priority": {before: todo.fields["Top priority"] ?? null, after: selected ? "No" : "Yes"}}}}]);
  }
  const [appointmentChange, setAppointmentChange] = useState<{ task: Pick<Task, "number" | "title">; after: TaskTiming; action: "Move" | "Resize" } | null>(null);
  async function persistTiming(retry = false) {
    if (!writable || timingLock.current || orderLock.current || (timingPaused.current && !retry)) return;
    timingPaused.current = false;
    timingLock.current = true;
    queue.set("savingTiming", true);
    queue.set("timingPending", null);
    const discardDependent = (edit: TimingEdit, message: string) => {
      todoHistory.discardTiming(edit.number);
      // A rejected predecessor invalidates subsequent edits to that task only.
      for (const queued of timingQueue.current.filter(item => item.number === edit.number))
        live.timing.fail(queued.command.commandId, message, true);
      timingQueue.current = timingQueue.current.filter(item => item.number !== edit.number);
    };
    try {
      while (timingQueue.current.length) {
        if ((orderQueue.current[0]?.sequence ?? Infinity) < (timingQueue.current[0].sequence ?? Infinity)) break;
        const edit = timingQueue.current[0];
        try {
          if (edit.command.fields?.Category) await categories.waitForWrites();
          const result = await saveTodoFacts(edit.number, edit.command, { replay: true });
          live.timing.finish(edit.command.commandId, result);
          const status = result.outcomes.timing;
          queue.set("timingMessage", status === "saved" ? "Task time saved." : result.message);
          if (status === "saved") {
            timingQueue.current.shift();
            if (clipboard?.cut && queue.getSnapshot().clipboard === clipboard) queue.set("clipboard", null);
            // Only advance the next command after a verified response. Never
            // rewrite a command already sent: retries must retain its payload.
            const next = timingQueue.current.find(item => item.number === edit.number);
            if (next && result.todo) next.command.revision = result.todo.updatedAt;
            const nextChange = orderQueue.current.find(item => item.number === edit.number);
            if (nextChange && result.todo && (nextChange.command.start !== undefined || nextChange.command.trash || nextChange.command.deadlineAt)) nextChange.command.revision = result.todo.updatedAt;
            if (next && !result.todo) {
              const message = "Time saved without a current revision. Later moves were cancelled; refresh and try again.";
              discardDependent(edit, message);
              queue.set("timingMessage", message);
            }
          } else if (result.retryable) {
            timingPaused.current = true;
            queue.set("timingPending", edit);
            break;
          } else {
            const message = `${result.message} Later moves of this task were cancelled.`;
            discardDependent(edit, message);
            queue.set("timingMessage", message);
          }
          if (!result.todo) await live.refreshAfterWrite();
        } catch (error) {
          const rejected = error instanceof TodoBrowserError && [400, 401, 403, 404, 409, 422].includes(error.status);
          const message = error instanceof Error ? error.message : "Time save unavailable.";
          live.timing.fail(edit.command.commandId, message, rejected);
          if (rejected) {
            discardDependent(edit, message);
            queue.set("timingMessage", `${message} Later moves of this task were cancelled.`);
            await live.refreshAfterWrite();
          } else {
            timingPaused.current = true;
            queue.set("timingPending", edit);
            queue.set("timingMessage", message);
            break;
          }
        }
      }
    } finally { timingLock.current = false; queue.set("savingTiming", false); if (orderQueue.current.length) void persistOrder(); }
  }
  async function replayHistory(direction: HistoryDirection) {
    if (!writable) return;
    try {
      if (todoHistory.replayLocal(direction)) return;
      if (todoHistory.replayChanges(direction, items => enqueueChanges(items, true))) return;
      if (todoHistory.replayTiming(direction, items => {
        const current = new Map(live.todos.map(todo => [todo.number, todo]));
        const edits = items.map(item => {
          const todo = current.get(item.number);
          if (!todo || JSON.stringify(taskTiming(todo)) !== JSON.stringify(item.expectedTiming))
            throw Error("This event changed since your edit. Review its current time before undoing or redoing.");
          const after = { start: item.command.start ?? null, end: item.command.end ?? null, allDay: item.command.allDay ?? false, fixed: item.command.fixed ?? false, beforeMinutes: item.command.beforeMinutes ?? 0, afterMinutes: item.command.afterMinutes ?? 0 };
          const edit: TimingEdit = { number: item.number, before: taskTiming(todo), command: { ...item.command, revision: todo.updatedAt, ...after } };
          current.set(item.number, { ...todo, ...after });
          return edit;
        });
        for (const edit of edits) {
          edit.sequence = ++editSequence.current;
          timingQueue.current.push(edit);
          live.timing.start(edit.command.commandId, edit.number, { start: edit.command.start!, end: edit.command.end ?? null, allDay: edit.command.allDay ?? false, fixed: edit.command.fixed ?? false, beforeMinutes: edit.command.beforeMinutes ?? 0, afterMinutes: edit.command.afterMinutes ?? 0 });
        }
      })) {
        queue.set("timingMessage", direction === "undo" ? "Time change undone. Saving…" : "Time change redone. Saving…");
        void persistTiming();
        return;
      }
    } catch (error) { queue.set("orderMessage", error instanceof Error ? error.message : "Could not restore this change."); return; }
    if (!writable || timingLock.current || orderLock.current || timingPending || pendingOrder.length || copyPending) return;
    let needsRefresh = false;
    const messages: string[] = [];
    const replayTodos = new Map(live.todos.map(todo => [todo.number, todo]));
    try {
      await todoHistory.replay(direction, async item => {
        const command = item.execution!;
        if (item.expectedTiming && command.start !== undefined) {
          const todo = replayTodos.get(item.number);
          if (!item.prepared && (!todo || JSON.stringify(taskTiming(todo)) !== JSON.stringify(item.expectedTiming)))
            throw Error("This event changed since your edit. Review its current time before undoing or redoing.");
          if (!item.prepared) command.revision = todo!.updatedAt;
          item.prepared = true;
          live.timing.start(command.commandId, item.number, { start: command.start, end: command.end ?? null, allDay: command.allDay ?? false, fixed: command.fixed ?? false, beforeMinutes: command.beforeMinutes ?? 0, afterMinutes: command.afterMinutes ?? 0 });
        }
        try {
          const result = await saveTodoFacts(item.number, command, { replay: true });
          if (command.start !== undefined) live.timing.finish(command.commandId, result);
          if (result.todo) replayTodos.set(item.number, result.todo);
          const message = Object.entries(result.outcomes).map(([key, value]) => `${key} ${value}`).join(", ");
          messages.push(message);
          if (command.start !== undefined) queue.set("timingMessage", messages.join(" · "));
          else queue.set("orderMessage", messages.join(" · "));
          if (!result.todo || Object.keys(command).some(key => ["fields", "title", "description", "closure", "trash"].includes(key))) needsRefresh = true;
          return result;
        } catch (error) {
          if (command.start !== undefined) live.timing.fail(command.commandId, String(error), error instanceof TodoBrowserError && [400, 401, 403, 404, 409, 422].includes(error.status));
          throw error;
        }
      });
    } catch (error) { queue.set("orderMessage", error instanceof Error ? error.message : "Could not restore this change."); }
    finally { if (needsRefresh) await live.refreshAfterWrite(); }
  }
  function changeTiming(number: number, after: TaskTiming) {
    const todo = live.todos.find(t => t.number === number);
    if (!todo || todo.scheduleError || !writable || history.replaying) return;
    const edit = { sequence: ++editSequence.current, number, before: taskTiming(todo), command: { commandId: crypto.randomUUID(), revision: todo.updatedAt, ...after } };
    todoHistory.recordTiming(number, edit.command, edit.before, after);
    timingQueue.current.push(edit);
    live.timing.start(edit.command.commandId, number, after);
    void persistTiming();
  }
  async function copyTask(command: components["schemas"]["TodoCreate"]) {
    const retry = copyQueue.current.some(item => item.commandId === command.commandId);
    if (!retry) {
      copyQueue.current.push(command);
      live.creation.start(command);
      todoHistory.clearRedo();
    }
    if (copyLock.current || (copyPaused.current && !retry)) return;
    copyPaused.current = false;
    queue.set("copyPending", null);
    copyLock.current = true;
    try {
      while (copyQueue.current.length) {
        const next = copyQueue.current[0];
        try {
          live.creation.start(next);
          const result = await saveTodoFacts(undefined, next, { replay: true });
          live.creation.finish(next.commandId, result);
          queue.set("timingMessage", result.message);
          if (result.retryable) { copyPaused.current = true; queue.set("copyPending", next); break; }
          copyQueue.current.shift();
          if (!result.todo) await live.refreshAfterWrite();
        } catch (error) {
          live.creation.fail(next.commandId, String(error));
          queue.set("timingMessage", String(error));
          copyPaused.current = true;
          queue.set("copyPending", next);
          break;
        }
      }
    } finally { copyLock.current = false; }
  }
  function requestTimingChange(task: Pick<Task, "number" | "title" | "fixed">, after: TaskTiming, action: "Move" | "Resize" = "Move") {
    if (task.fixed) setAppointmentChange({ task, after, action });
    else changeTiming(task.number, after);
  }
  const actionsForDate = (target: string): Actions => {
    const tasks = todosForDate(visibleTodos, target);
    return { deadlines: visibleTodos.filter(todo => todo.fields.Due === target).map(todoTask), trash: task => {
      const todo = lifecycleTodos.find(item => item.number === task.number); if (!todo) return;
      enqueueChanges([{ number: task.number, command: { commandId: crypto.randomUUID(), revision: todo.updatedAt, trash: { before: false, after: true } } }]);
    }, makeTimed: (task, minute) => {
      try {
        const start = timingInstant(`${target}T${time(minute)}`)!;
        requestTimingChange(task, { start, end: new Date(Date.parse(start) + 30 * 60000).toISOString(), allDay: false, fixed: !!task.fixed });
      } catch (error) { queue.set("timingMessage", (error as Error).message); }
    }, makeAllDay: task => {
      try { requestTimingChange(task, { start: timingInstant(`${target}T00:00`), end: timingInstant(`${shiftDate(target, 1)}T00:00`), allDay: true, fixed: !!task.fixed }); }
      catch (error) { queue.set("timingMessage", (error as Error).message); }
    }, resize: (task, edge, minute) => {
      const todo = live.todos.find(t => t.number === task.number);
      if (!todo) return;
      try { requestTimingChange(task, resizeTaskTiming(todo, target, edge, minute), "Resize"); }
      catch (error) { queue.set("timingMessage", (error as Error).message); }
    }, priorityReadOnly: !writable || history.replaying, readOnly: !writable || history.replaying, canAdd: writable, tasks, priorities: tasks.filter((task) => priorities.includes(task.issueId)).map((task) => task.id), date: target,
      copyEvent: (task, cut) => { queue.set("clipboard", { number: task.number, cut }); queue.set("timingMessage", cut ? "Task selected to move. Paste on destination date." : "Task copied. Paste creates a new task."); },
      pasteEvent: () => {
        const todo = live.todos.find(t => t.number === clipboard?.number);
        if (!todo || !clipboard) return;
        try {
          const wall = localDateTime(todo.start);
          const after = moveTaskTiming(todo, target, minute(wall.slice(11, 16)));
          if (clipboard.cut) requestTimingChange(todo, after);
          else void copyTask({ commandId: crypto.randomUUID(), title: todo.title, ...after });
        } catch (error) { queue.set("timingMessage", (error as Error).message); }
      }, canPaste: !!clipboard && writable && !history.replaying,
      removeEvent: task => changeTiming(task.number, { start: null, end: null, allDay: false, fixed: false }), complete: task => {
        const todo = live.todos.find(item => item.number === task.number);
        if (!todo) return;
        const before = todo.state === "open" ? { outcome: "open" as const } : todo.closureReason === "duplicate" && todo.duplicateOf ? { outcome: "duplicate" as const, number: todo.duplicateOf.number } : { outcome: todo.closureReason === "not_planned" ? "not_planned" as const : "completed" as const };
        enqueueChanges([{ number: task.number, command: { commandId: crypto.randomUUID(), closure: { before, after: { outcome: task.state === "completed" ? "open" : "completed" } } } }]);
      }, togglePriority,
      reschedule: (task, start) => { const todo = live.todos.find(t => t.number === task.number); if (!todo) return; try { requestTimingChange(task, moveTaskTiming(todo, target, start, task.start && task.plannedDate ? { date: task.plannedDate, start: task.start } : undefined)); } catch (error) { queue.set("timingMessage", (error as Error).message); } }, openAdd: (start, allDay = false) => {
        const localStart = `${target}T${start ?? "09:00"}`;
        const localEnd = allDay ? `${shiftDate(target, 1)}T00:00` : new Date(Date.parse(`${localStart}:00Z`) + 30 * 60000).toISOString().slice(0, 16);
        setCreationTiming({ start: localStart, end: localEnd, allDay }); setAdding(true);
      },
      edit: task => { setSelectedEvent(task.id); setDetailNumber(task.number); }, isEventSelected: id => (detailEventId ?? (adding ? createdEventId : null) ?? selectedEvent) === id, selectEvent: setSelectedEvent };
  };
  const undoable = (title: string) => toaster.create({ title, type: "info", duration: 5000, action: { label: "Undo", onClick: () => void replayHistory("undo") } });
  const viewActions: ViewActions = {
    activityTimestamp: clock.timestamp,
    readOnly: !writable || history.replaying,
    delegates: delegateControls,
    decisions: decisionControls,
    toggleDone: t => { actionsForDate(date).complete(t.task); undoable(t.task.state === "completed" ? "Reopened" : "Completed"); },
    setCommitment: (t, to) => {
      const todo = live.todos.find(item => item.number === t.number);
      if (!todo || todo.fields.Commitment === to) return;
      enqueueChanges([{ number: t.number, command: { commandId: crypto.randomUUID(), fields: { Commitment: { before: todo.fields.Commitment ?? null, after: to } } } }]);
      undoable(to === "Active" ? "Committed" : to === "Someday" ? "Moved to Someday" : "Moved to Inbox");
    },
    togglePriority: t => togglePriority(t.id),
    open: t => { setSelectedEvent(t.id); setDetailNumber(t.number); },
    add: () => { setCreationTiming(undefined); setAdding(true); },
    undo: () => void replayHistory("undo"),
  };
  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.defaultPrevented || (event.target instanceof Element && event.target.closest('input,textarea,select,[role="dialog"],[role="alertdialog"],[role="menu"],[contenteditable]:not([contenteditable="false"])'))) return;
    const command = event.metaKey || (event.ctrlKey && !event.altKey), key = event.key.toLowerCase();
    if (command && ["1", "2", "3", "4", "5"].includes(key)) { event.preventDefault(); navigate(date, (["calendar", "week", "month", "year", "list"] as CalendarView[])[Number(key) - 1]); }
    else if (command && key === "t") { event.preventDefault(); if (event.shiftKey) { setJumpDate(date); setUtility("date"); } else goToday(); }
    else if (command && ["arrowleft", "arrowright"].includes(key)) { event.preventDefault(); navigatePeriod(key === "arrowleft" ? -1 : 1); }
    else if (command && key === "z") { event.preventDefault(); void replayHistory(event.shiftKey ? "redo" : "undo"); }
    else if (command && key === "f") { event.preventDefault(); setUtility("search"); }
    else if (key === "?") { event.preventDefault(); setUtility("shortcuts"); }
    else if (command && ["c", "x"].includes(key) && selectedEvent) {const a = actionsForDate(date); const task = a.tasks.find(t => t.id === selectedEvent); if (task && !a.readOnly) {event.preventDefault(); a.copyEvent(task, key === "x");}}
    else if (command && key === "v" && clipboard) {event.preventDefault(); actionsForDate(date).pasteEvent();}
    else if (["Backspace", "Delete"].includes(event.key) && selectedEvent) {const a = actionsForDate(date); const task = a.tasks.find(t => t.id === selectedEvent); if (task && !a.readOnly) {event.preventDefault(); a.removeEvent(task);}}
    else if (command && ["e", "i"].includes(key) && selectedEvent) { event.preventDefault(); const todo = live.todos.find((todo) => todo.id === selectedEvent); if (todo) setDetailNumber(todo.number); }
  });
  useEffect(() => { const listener = (event: KeyboardEvent) => keyboard(event); window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, []);
  const closeDetail = () => {
    setDetailNumber(null);
    if (params.has("task")) { const next = new URLSearchParams(params.toString()); next.delete("task"); router.replace(`${pathname}?${next}` as Route, { scroll: false }); }
  };
  const requestedTask = Number(params.get("task"));
  useEffect(() => {
    if (nativeId) setDetailNumber(null);
    else if (Number.isSafeInteger(requestedTask) && requestedTask > 0) setDetailNumber(requestedTask);
  }, [nativeId, requestedTask]);
  const jarvisUi = useJarvisUi();
  const categoryCommands = useJarvisCategoryCommands({ todos: allTodos, writable });
  const calendarView: JarvisCalendarView = view === "calendar" ? "day" : view;
  const selectedTaskNumber = detailNumber ?? live.todos.find(todo => todo.id === selectedEvent)?.number ?? null;
  const selectedTaskTitle = live.todos.find(todo => todo.number === selectedTaskNumber)?.title ?? null;
  const panel = detailNumber !== null ? "task" : adding ? "new-task" : utility === "trash" ? "shortcuts" : utility;
  const jarvisAction = useEffectEvent((action: JarvisUiAction) => {
    if (action.type === "change_category") {
      const { type: _type, ...command } = action;
      return categoryCommands.execute(command).then(result => typeof result === "string" ? result : JSON.stringify(result));
    }
    if (action.type === "category_filter") {
      if (live.status === "denied") return "Category filter unavailable: To-Do access denied.";
      const category = action.filter === "category" ? categories.categories.find(item => item.id === action.categoryId) : undefined;
      if (action.filter === "category" && !category) return "Category unavailable. Use an existing category from the current UI context.";
      setCategoryFilter(action.filter === "all" ? "__all" : action.filter === "uncategorized" ? "__none" : String(category!.id));
      return {
        message: `Showing ${action.filter === "all" ? "all categories" : action.filter === "uncategorized" ? "uncategorized tasks" : category!.name}.`,
        complete: (context: import("./jarvis-ui").JarvisUiContext) => context.categoryFilter?.filter === action.filter && context.categoryFilter?.categoryId === action.categoryId,
      };
    }
    const closePanels = () => { setUtility(null); setAdding(false); setDetailNumber(null); };
    if (action.type === "close") {
      if (!panel) return "No panel is open.";
      // Close only the frontmost panel, using the same handlers as its close button.
      if (detailNumber !== null) closeDetail();
      else if (adding) setAdding(false);
      else setUtility(null);
      const nextPanel = detailNumber !== null ? adding ? "new-task" : utility === "trash" ? "shortcuts" : utility : adding ? utility === "trash" ? "shortcuts" : utility : null;
      return { message: "Closed the panel.", complete: (context: { panel: string | null }) => context.panel === nextPanel };
    }
    if (action.type === "task") {
      closePanels();
      setDetailNumber(action.number);
      router.replace(`${pathname}?${new URLSearchParams({ view, date, task: String(action.number) })}` as Route, { scroll: false });
      return { message: `Opened task #${action.number}.`, complete: (context: { selectedTask: { number: number } | null; panel: string | null }) => context.selectedTask?.number === action.number && context.panel === "task" };
    }
    closePanels();
    let nextDate = date, nextView = view;
    if (action.type === "view") nextView = action.view === "day" ? "calendar" : action.view;
    else if (action.target === "today") { nextDate = currentDate; nextView = view === "year" ? "calendar" : view; }
    else if (action.target === "date") nextDate = action.date!;
    else nextDate = periodDate(action.target === "next" ? 1 : -1);
    if (action.type === "date" && action.target === "today") goToday();
    else navigate(nextDate, nextView);
    const publicView = nextView === "calendar" ? "day" : nextView;
    return {
      message: `Showing ${publicView} view at ${nextDate}.`,
      complete: (context: { calendarView: JarvisCalendarView | null; date: string | null; panel: string | null }) => context.calendarView === publicView && context.date === nextDate && context.panel === null,
    };
  });
  useEffect(() => jarvisUi?.register(action => jarvisAction(action)), [jarvisUi]);
  useJarvisTaskContext(jarvisUi, { page: pathname, calendarView, date, selectedTask: selectedTaskNumber ? { number: selectedTaskNumber, title: selectedTaskTitle } : null, panel, categoryFilter: categoryFilter === "__all" ? { filter: "all" } : categoryFilter === "__none" ? { filter: "uncategorized" } : { filter: "category", categoryId: Number(categoryFilter) }, categories: categories.categories.map(({ id, name, color }) => ({ id, name, color, ...(id < 0 ? { pending: true } : {}) })) }, allTodos, visibleTodos, currentDate, live.status);
  useEffect(() => categories.registerQueue((command, baseline) => new Promise<void>((resolve, reject) => { if (orderPaused.current) { reject(Error("Retry pending task saves first.")); return; } enqueueChanges([{ number: baseline.number, command, expectedTiming: taskTiming(baseline), settled: { resolve, reject } }]); })), [categories.registerQueue, enqueueChanges]);
  const invalidSchedule = live.todos.find((todo) => todo.scheduleError);

  const todayInView = (view === "calendar" || view === "week") && currentTimeVisibility.rangeKey === `${view}:${date}` && currentTimeVisibility.visible;
  return <div className={s.workspace} data-slot="todo-workspace" data-view={view} data-layout={space ? layout : undefined}>
    {space && <TodoSpaceBar layout={layout} onLayout={setLayout} todos={live.todos} canUndo={history.canUndo} onUndo={() => void replayHistory("undo")} onAdd={() => { setCreationTiming(undefined); setAdding(true); }} readOnly={!writable || history.replaying} />}
    {!space && <CalendarTopBar onOpenTrash={() => setUtility("trash")} categoryControl={<CategoryFilter value={categoryFilter} categories={categories.categories} writable={writable} onChange={setCategoryFilter} onManage={() => setManagingCategories(true)} />} date={date} view={view} todayInView={todayInView} onPrevious={() => navigatePeriod(-1)} onNext={() => navigatePeriod(1)} onToday={goToday} onDateChange={(target) => navigate(target)} onViewChange={CalendarSurface ? (next) => navigate(date, next) : undefined} onAddTask={() => { setCreationTiming(undefined); setAdding(true); }} readOnly={!writable} onOpenShortcuts={() => setUtility("shortcuts")} />}
    {managingCategories && <CategoryManager mode="manage" onClose={() => setManagingCategories(false)} onCreated={category => { setCategoryFilter(String(category.id)); setManagingCategories(false); }} />}
    {space ? <div className={s.daySurface} style={{ overflowY: "auto" }}>
      {layout !== "triage" && layout !== "board" && <NativeAppointmentList date={date} enabled={hasNativeAppointments} onOpen={openAppointment} />}
      <TodoViews layout={layout} todos={live.todos} today={currentDate} now={clockLabel} actions={viewActions} loading={live.status === "loading"} agentInbox={ownerSession && canReadTodos ? { canWrite } : undefined} />
    </div> : <main className={s.daySurface} data-range={view === "week" || view === "month" || view === "year"} aria-label="To-Do calendar">
      {view === "calendar" && <p className={s.dayWeekday}>{new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</p>}
      {live.status !== "denied" && CalendarSurface && <CalendarSurface hasSubscriptions={canReadBudget} hasHabits={canReadHabits} hasNativeAppointments={hasNativeAppointments} hasMeetings={canReadMeetings && categoryFilter === "__all"} canCancelMeetings={canCancelMeetings} openAppointment={openAppointment} subscribeTasks={rawLive.subscribe} date={date} view={view} todayScrollRequest={todayScrollRequest} onCurrentTimeVisibilityChange={setCurrentTimeVisibility} actionsForDate={actionsForDate} navigate={navigate} />}

    </main>}
    <div className={s.connectionSlot} data-slot="todo-connection-slot">
      {(live.writeError || orderMessage || timingMessage || invalidSchedule || history.canUndo || history.canRedo) && <div className={u.mutationStatus} role="status" data-slot="todo-mutation-status"><span>{(timingPending || copyPending || savingTiming ? timingMessage || "Saving time…" : orderMessage || live.writeError || timingMessage)}</span>{invalidSchedule && <Button variant="ghost" size="xs" onClick={() => setDetailNumber(invalidSchedule.number)}>Review task timing</Button>}{pendingOrder.length > 0 && <Button size="xs" variant="outline" onClick={() => void persistOrder(true)}>Retry changes</Button>}{(timingPending || copyPending) && <Button size="xs" variant="outline" onClick={() => { if (copyPending) void copyTask(copyPending); else void persistTiming(true); }}>Retry timing</Button>}{history.canUndo && <Button size="xs" variant="ghost" onClick={() => void replayHistory("undo")}>Undo</Button>}{history.canRedo && <Button size="xs" variant="ghost" onClick={() => void replayHistory("redo")}>Redo</Button>}</div>}
      {canReadJobs && !nativeId && <NativeAppointmentSaveNotice onOpen={openAppointment} />}
      {[...delegates.entries].filter(([, entry]) => entry.message).map(([id, entry]) => <div key={id} className={u.mutationStatus} role="status"><span>{entry.message}</span>{entry.retryable && <Button size="xs" variant="outline" onClick={() => void queue.delegates.retry(id)}>Retry delegate change</Button>}</div>)}
      {[...decisions].filter(([, entry]) => entry.error).map(([id, entry]) => <div key={id} className={u.mutationStatus} role="status"><span>{entry.error}</span>{entry.retry && <Button size="xs" variant="outline" onClick={() => void queue.decisions.retry(id)}>Retry decision</Button>}</div>)}
      <TodoReadStatus categoryStatus={categories.error ? { state: "error", message: categories.error, retry: async () => { if (categories.canRetry) await categories.retry(); else await categories.refresh(); } } : categories.pending ? { state: "saving", message: "Saving categories…" } : !categories.revision ? { state: "loading", message: "Loading categories…" } : undefined} status={live.status} message={live.message} readAt={live.readAt} retryAt={live.retryAt} preview={process.env.NODE_ENV === "development" && statusPreview !== "automatic" ? statusPreview : undefined} refresh={process.env.NODE_ENV === "development" && statusPreview !== "automatic" ? async () => { setStatusPreview("online"); } : live.refresh} /></div>
    <Dialog.Root role="alertdialog" placement="center" size="xs" closeOnInteractOutside={false} lazyMount unmountOnExit open={appointmentChange !== null} onOpenChange={({ open }) => { if (!open) setAppointmentChange(null); }}>
      <Portal><Dialog.Backdrop bg="blackAlpha.100" backdropFilter="blur(4px)" /><Dialog.Positioner><Dialog.Content maxW={{ base: "calc(100vw - 2rem)", sm: "384px" }}>
        <Dialog.Header flexDirection="column"><Dialog.Title>{appointmentChange?.action} appointment?</Dialog.Title>
          <Dialog.Description>{appointmentChange?.action} “{appointmentChange?.task.title}” to {appointmentChange && localDateTime(appointmentChange.after.start).replace("T", " ")}–{appointmentChange && localDateTime(appointmentChange.after.end).replace("T", " ")}? It will remain a fixed appointment.</Dialog.Description></Dialog.Header>
        <Dialog.Footer flexDirection={{ base: "column-reverse", sm: "row" }} alignItems={{ base: "stretch", sm: "center" }}><Dialog.CloseTrigger asChild><Button variant="outline">Cancel</Button></Dialog.CloseTrigger><Button disabled={!writable || history.replaying} onClick={() => {
          if (appointmentChange) changeTiming(appointmentChange.task.number, appointmentChange.after);
          setAppointmentChange(null);
        }}>{appointmentChange?.action} appointment</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Positioner></Portal>
    </Dialog.Root>
    <Drawer.Root lazyMount unmountOnExit open={utility !== null} onOpenChange={({ open }) => { if (!open) setUtility(null); }}>
      <Portal><Drawer.Backdrop bg="blackAlpha.100" backdropFilter="blur(4px)" /><Drawer.Positioner><Drawer.Content w="75vw" maxW={{ base: "none", sm: "384px" }}>
        <Drawer.Header className={u.drawerHeader} flexDirection="column" alignItems="start">
          <Drawer.Title>{utility === "trash" ? "Trash" : utility === "search" ? "Search To-Dos" : utility === "date" ? "Go to date" : utility === "planning" ? "Planning suggestions" : "Keyboard shortcuts"}</Drawer.Title>
          <Drawer.Description>{utility === "trash" ? "Deleted tasks retain their history. Restore to return a task to the list." : utility === "search" ? "Find a task by its title or description." : utility === "date" ? "Jump to a date in the current calendar view." : utility === "planning" ? "Review proposed changes before applying them." : "Navigate the calendar and manage task times."}</Drawer.Description>
        </Drawer.Header>
        <div className={u.drawerBody}>
          {utility === "trash" && <div className={u.stack}>
            {!(rawLive.trashTodos ?? []).length && <p className={u.muted}>Trash is empty.</p>}
            {(rawLive.trashTodos ?? []).map(todo => <div key={todo.id} className={u.trashRow}><span className={u.wrap}>{todo.title}{todo.trashError && <span role="alert" className={u.error}>{todo.trashError}</span>}</span><Button variant="outline" size="sm" disabled={!writable || !!todo.trashError} onClick={() => enqueueChanges([{ number: todo.number, command: { commandId: crypto.randomUUID(), revision: todo.updatedAt, trash: { before: true, after: false } } }])}>Restore</Button></div>)}
          </div>}
          {utility === "date" && <form onSubmit={(event) => { event.preventDefault(); if (jumpDate) { navigate(jumpDate); setUtility(null); } }}>
            <Stack>
              <Field.Root><Field.Label htmlFor="todo-jump-date">Date</Field.Label><Input id="todo-jump-date" aria-label="Go to date" type="date" required value={jumpDate} onChange={(event) => setJumpDate(event.target.value)} /></Field.Root>
              <Button type="submit" className={u.start}>Go</Button>
            </Stack>
          </form>}
          {utility === "search" && <>
            <Field.Root><Field.Label htmlFor="todo-search">Search</Field.Label><Input id="todo-search" aria-label="Search To-Dos" placeholder="Search tasks…" value={searchText} onChange={(event) => setSearchText(event.target.value)} /></Field.Root>
            <div className={u.results}>
              {records.filter((task) => `${task.title} ${task.note}`.toLowerCase().includes(searchText.toLowerCase())).map((task) => <Button variant="ghost" className={u.result} key={task.id} onClick={() => { setUtility(null); setDetailNumber(task.number); }}><span className={u.wrap}>{task.title}</span></Button>)}
              {!records.some((task) => `${task.title} ${task.note}`.toLowerCase().includes(searchText.toLowerCase())) && <p className={u.muted}>No matching tasks.</p>}
            </div>
          </>}
          {utility === "planning" && <TodoSuggestions embedded writable={writable} refreshTasks={live.refreshAfterWrite} editTask={setDetailNumber} />}
          {utility === "shortcuts" && <>
            <div className={u.actions}><Button variant="outline" onClick={() => void live.refresh()}>Refresh tasks</Button><Button variant="outline" onClick={() => setUtility("planning")}>Planning suggestions</Button></div>
            {process.env.NODE_ENV === "development" && <Stack>
              <Field.Root>
                <Field.Label>Status bar preview</Field.Label>
                <SegmentGroup.Root minW="0" size="sm" value={statusPreview} aria-label="Status bar preview" className={u.wrapControls} onValueChange={({ value }) => {
                  if (value !== "automatic" && value !== "loading" && value !== "offline" && value !== "online") return;
                  setStatusPreview(value);
                  setUtility(null);
                }}>
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Item value="automatic"><SegmentGroup.ItemText>Automatic</SegmentGroup.ItemText><SegmentGroup.ItemHiddenInput /></SegmentGroup.Item>
                  <SegmentGroup.Item value="loading"><SegmentGroup.ItemText>Loading</SegmentGroup.ItemText><SegmentGroup.ItemHiddenInput /></SegmentGroup.Item>
                  <SegmentGroup.Item value="offline"><SegmentGroup.ItemText>Offline</SegmentGroup.ItemText><SegmentGroup.ItemHiddenInput /></SegmentGroup.Item>
                  <SegmentGroup.Item value="online"><SegmentGroup.ItemText>Back online</SegmentGroup.ItemText><SegmentGroup.ItemHiddenInput /></SegmentGroup.Item>
                </SegmentGroup.Root>
                <p className={u.hint}>Preview only. Choose Automatic to restore live status. Preview Retry shows Back online.</p>
              </Field.Root>
            </Stack>}
            <dl className={u.shortcuts}>
              {[
                ["⌘1–5", "Day / Week / Month / Year / List"],
                ["⌘← / →", "Previous / next period"],
                ["⌘T", "Today"],
                ["⇧⌘T", "Go to date"],
                ["⌘F", "Search"],
                ["Enter", "Task details (or double-click an event)"],
                ["Arrow keys", "Move between dates"],
                ["⌘C / X / V", "Copy / move / paste a task on the selected date"],
                ["Delete", "Unschedule a task"],
                ["⌘Z / ⇧⌘Z", "Undo / redo task changes"],
                ["Drag", "15-minute steps; ⌘: 5 minutes; Shift: precise"],
                ["Alt↑ / ↓", "Move a task five minutes"],
              ].map(([keys, description]) => <div key={keys} className={u.shortcut}><dt><Kbd>{keys}</Kbd></dt><dd className={u.description}>{description}</dd></div>)}
            </dl>
          </>}
        </div>
      <Drawer.CloseTrigger asChild><CloseButton aria-label="Close" position="absolute" top="2" right="2" /></Drawer.CloseTrigger></Drawer.Content></Drawer.Positioner></Portal>
    </Drawer.Root>
    {live.status !== "denied" && <AnimatePresence>
    {adding && <NewTaskPopover key="new-task" onCreated={todo => { setSelectedEvent(todo.id); setCreatedEventId(todo.id); }} onQueue={(command, baseline) => { if (!writable || history.replaying) throw Error("Task editing unavailable. Your draft has been kept."); enqueueChanges([{ number: baseline.number, command, expectedTiming: taskTiming(baseline) }]); }} onClose={() => setAdding(false)} initialTiming={creationTiming ?? newTaskTiming(allTodos)} creation={live.creation} disabled={!writable} onSaved={() => void live.refreshAfterWrite()} />}
    {!nativeId && detailNumber !== null && <TodoDetail preview={live.todos.find(todo => todo.number === detailNumber)} delegates={delegateControls} decisions={decisionControls} decisionProjection={decisions} onQueue={(command, baseline) => { if (!writable || history.replaying) throw Error("Task editing unavailable. Your draft has been kept."); enqueueChanges([{ number: baseline.number, command, expectedTiming: taskTiming(baseline) }]); }} key={detailNumber} number={detailNumber} revision={live.readAt} canWrite={canWrite} canApprove={canApprove} onSaved={() => void live.refreshAfterWrite()} stale={!["ready", "empty"].includes(live.status)} onClose={closeDetail} />}
    {!nativeId && returning && <ReturnHandBackDialog key={returning.id} todo={returning} close={() => setReturning(null)} send={reply => {
      decisionControls.decide(returning, { decision: "return", reply }); setReturning(null);
    }} />}
    </AnimatePresence>}
    {nativeId && <NativeAppointmentDetail key={nativeId} id={nativeId} enabled={canReadJobs} canWrite={canWriteJobs} preview={appointmentPreview?.id === nativeId ? appointmentPreview : undefined} onClose={closeAppointment} />}
  </div>;
}

export function TodoReadStatus({ status, message, refresh, preview, categoryStatus }: { categoryStatus?: { state: "error" | "loading" | "saving"; message: string; retry?: () => Promise<unknown> }; preview?: "loading" | "offline" | "online"; status: string; message: string; readAt: string | null; retryAt: number; refresh: () => Promise<void> }) {
  const offline = status === "stale" || status === "unavailable";
  const [wasOffline, setWasOffline] = useState(offline);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (offline) setWasOffline(true);
    else if (status === "denied") setWasOffline(false);
  }, [offline, status]);
  const recovered = wasOffline && (status === "ready" || status === "empty");
  useEffect(() => {
    if (!recovered) return;
    const timer = setTimeout(() => setWasOffline(false), 4000);
    return () => clearTimeout(timer);
  }, [recovered]);
  const shown = preview ?? (offline ? "offline" : recovered ? "online" : status === "loading" ? "loading" : status === "denied" ? "denied" : "hidden");
  const showCategory = !preview && !offline && status !== "denied" && status !== "loading" && !!categoryStatus;
  if (shown === "hidden" && !showCategory) return null;
  const failed = showCategory ? categoryStatus?.state === "error" : shown === "offline" || shown === "denied";
  const label = showCategory ? failed ? "Categories need attention" : categoryStatus!.message : shown === "offline" ? "Offline · Edits paused" : shown === "online" ? "Back online" : shown === "denied" ? message : "Loading tasks…";
  return <div
    role={failed ? "alert" : "status"}
    aria-atomic="true"
    data-slot="todo-connection-status"
    data-state={failed ? "offline" : showCategory ? "loading" : shown}
    className={s.connectionStatus}
  >
    <span className={u.status} title={failed ? showCategory ? categoryStatus?.message : message : undefined}>
      {(shown === "loading" || (showCategory && !failed)) && <Spinner className={u.spinner} aria-hidden="true" />}
      {label}
    </span>
    {failed && <Button variant="outline" size="xs" disabled={retrying} onClick={async () => {
      setRetrying(true);
      try { if (showCategory) await categoryStatus?.retry?.(); else await refresh(); } finally { setRetrying(false); }
    }}>{retrying ? "Retrying…" : showCategory ? "Retry categories" : "Retry"}</Button>}
  </div>;
}
