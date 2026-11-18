"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { CategoryProvider } from "./todo-categories";
import { useLiveTodos } from "./todo-live";
import type { components } from "@/lib/generated/quantself-api-schema";
import { todoHistory } from "./todo-history";
import type { TaskTiming } from "./todo-timing";
import { NativeAppointmentQueueProvider } from "./native-appointment-queue";
import { createTodoDelegateQueue } from "./todo-delegate-queue";
import { createTodoDecisionQueue } from "./todo-decision-queue";

export type OrderEdit = {
  settled?: { resolve(): void; reject(error: Error): void };
  sequence?: number;
  number: number;
  command: components["schemas"]["TodoEdit"];
  expectedTiming?: TaskTiming;
};
export type TimingEdit = OrderEdit & { before: TaskTiming };
type CopyCommand = components["schemas"]["TodoCreate"];

type QueueStatus = {
  orderMessage: string;
  pendingOrder: OrderEdit[];
  timingMessage: string;
  timingPending: TimingEdit | null;
  savingTiming: boolean;
  copyPending: CopyCommand | null;
  clipboard: { number: number; cut: boolean } | null;
};

function createWorkspaceQueue() {
  const listeners = new Set<() => void>();
  let status: QueueStatus = {
    orderMessage: "",
    pendingOrder: [],
    timingMessage: "",
    timingPending: null,
    savingTiming: false,
    copyPending: null,
    clipboard: null,
  };
  return {
    delegates: createTodoDelegateQueue(id => todoHistory.discardLocal(id)),
    decisions: createTodoDecisionQueue(id => todoHistory.discardLocal(id)),
    orderLock: { current: false },
    orderPaused: { current: false },
    orderQueue: { current: [] as OrderEdit[] },
    timingLock: { current: false },
    timingPaused: { current: false },
    timingQueue: { current: [] as TimingEdit[] },
    editSequence: { current: 0 },
    copyQueue: { current: [] as CopyCommand[] },
    copyLock: { current: false },
    copyPaused: { current: false },
    getSnapshot: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set<Key extends keyof QueueStatus>(key: Key, value: QueueStatus[Key]) {
      if (Object.is(status[key], value)) return;
      status = { ...status, [key]: value };
      for (const listener of listeners) listener();
    },
  };
}

type WorkspaceSession = {
  queue: ReturnType<typeof createWorkspaceQueue>;
  live: ReturnType<typeof useLiveTodos>;
};
const Workspace = createContext<WorkspaceSession | null>(null);
export const useSharedTaskWorkspace = () => useContext(Workspace);

// Keep in-flight commands, retry receipts and history alive when the two task
// surfaces exchange their route leaves.
export function TaskWorkspaceProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(createWorkspaceQueue);
  const path = usePathname();
  const active = path === "/todo" || path === "/calendar";
  const live = useLiveTodos(active);
  useEffect(() => () => todoHistory.reset(), []);
  return <Workspace.Provider value={{ queue, live }}><NativeAppointmentQueueProvider><CategoryProvider active={active}>{children}</CategoryProvider></NativeAppointmentQueueProvider></Workspace.Provider>;
}

export function useTaskWorkspaceQueue() {
  const shared = useSharedTaskWorkspace();
  const [queue] = useState(() => shared?.queue ?? createWorkspaceQueue());
  const localLive = useLiveTodos(!shared);
  useEffect(() => () => { if (!shared) todoHistory.reset(); }, [shared]);
  const status = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return { queue, status, live: shared?.live ?? localLive };
}
