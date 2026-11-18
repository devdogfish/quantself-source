"use client";

import { useCallback, useSyncExternalStore } from "react";

export const HABIT_LOOKS = [
  { value: "hatched", label: "Hatched", description: "Striped fill" },
  { value: "glyph", label: "Loop icon", description: "Event card + repeat icon" },
  { value: "outlined", label: "Outlined", description: "Unfilled, hairline outline" },
  { value: "ring", label: "Ring", description: "Hollow circle, like Reminders" },
  { value: "outlined-glyph", label: "Outlined + icon", description: "Outline with repeat icon" },
] as const;

export const EVENT_LOOKS = [
  { value: "filled", label: "Filled", description: "Solid fill (default)" },
  { value: "hatched", label: "Hatched", description: "Striped fill" },
  { value: "outlined", label: "Outlined", description: "Unfilled, hairline outline" },
  { value: "ring", label: "Ring", description: "Hollow circle instead of bar" },
] as const;

export type HabitLook = (typeof HABIT_LOOKS)[number]["value"];
export type EventLook = (typeof EVENT_LOOKS)[number]["value"];
export type EventKind = "task" | "appointment" | "meeting";
export const EVENT_KINDS: { kind: EventKind; title: string; help: string }[] = [
  { kind: "task", title: "Todo events", help: "Scheduled todos on the Calendar." },
  { kind: "appointment", title: "Appointments", help: "Fixed appointments on the Calendar." },
  { kind: "meeting", title: "Meetings", help: "Meetings on the Calendar." },
];
export const DEFAULT_HABIT_LOOK: HabitLook = "hatched";
export const DEFAULT_EVENT_LOOK: EventLook = "filled";
export const HABIT_LOOK_KEY = "quantself.habit-look";
const eventKey = (kind: EventKind) => `quantself.calendar-look.${kind}`;

function read<T extends string>(key: string, allowed: readonly { value: T }[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.some((item) => item.value === value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
export const savedHabitLook = () => read(HABIT_LOOK_KEY, HABIT_LOOKS, DEFAULT_HABIT_LOOK);
export const savedEventLook = (kind: EventKind) => read(eventKey(kind), EVENT_LOOKS, DEFAULT_EVENT_LOOK);

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((listener) => listener());
}

/** Saved in this browser; server render and hydration use the defaults. */
export function useHabitLook() {
  const look = useSyncExternalStore(subscribe, savedHabitLook, () => DEFAULT_HABIT_LOOK);
  const setLook = useCallback((value: HabitLook) => write(HABIT_LOOK_KEY, value), []);
  return { look, setLook };
}

export function useEventLook(kind: EventKind) {
  const look = useSyncExternalStore(subscribe, () => savedEventLook(kind), () => DEFAULT_EVENT_LOOK);
  const setLook = useCallback((value: EventLook) => write(eventKey(kind), value), [kind]);
  return { look, setLook };
}
