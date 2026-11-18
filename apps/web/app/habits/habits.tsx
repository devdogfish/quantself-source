"use client";
import { Button, Flex, Stack, Text, chakra } from "@chakra-ui/react";

import { HabitNote } from "./habit-note";
import { PrototypeToday } from "./habits-prototype";
import { PrototypeShell } from "./habits-prototype-shell";
import { PrototypeGuide } from "./habits-prototype-guide";
import type { Variant } from "./habits-prototype-variant";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  habitToday as today,
  type HabitDay,
  type Occurrence,
} from "./habit-store";
import { readHabitDay, habitStore } from "./habits-api";

type Projection = NonNullable<HabitDay["projection"]>;
type Stack = Projection["stacks"][number];
type Habit = Projection["habits"][number];

// Fields the page already presents (or that only drive scheduling) stay out of "More".
const HIDDEN_HABIT_KEYS = new Set([
  "id",
  "name",
  "stack",
  "order",
  "kind",
  "tracked",
  "status",
  "startDate",
  "schedule",
  "alert",
  "gate",
  "minimum",
  "fallbackAt",
]);
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const STATUS_BUTTONS = [
  { status: "done", label: "Done" },
  { status: "minimum", label: "Minimum" },
  { status: "skipped", label: "Skip" },
] as const;

const halifaxClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Halifax",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(", ");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, item]) => `${label(key)}: ${text(item)}`)
      .join(" · ");
  return String(value ?? "");
}
function label(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced[0]!.toUpperCase() + spaced.slice(1);
}
function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
function displayDate(date: string, current: string) {
  if (date === current) return "Today";
  if (date === shiftDate(current, -1)) return "Yesterday";
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}
function displayTime(anchor: string) {
  const [h, m] = anchor.split(":").map(Number);
  const hour = h! % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h! < 12 ? "am" : "pm"}`;
}
function minimumOf(habit: Habit) {
  const value: unknown = (habit as { minimum?: unknown }).minimum;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function isDue(habit: Habit, stack: Stack, date: string) {
  const schedule = habit.schedule ?? stack.days;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return (
    schedule === "daily" ||
    (schedule === "weekdays"
      ? weekday > 0 && weekday < 6
      : schedule.includes(WEEKDAYS[weekday]!))
  );
}
function isActive(habit: Habit, date: string) {
  return (
    ["testing", "building", "established"].includes(habit.status) &&
    (!habit.startDate || habit.startDate <= date)
  );
}

export function Habits({
  initialDate,
  stackId,
  variant,
  prototypeSection = "today",
}: {
  prototypeSection?: "today" | "system" | "playbook";
} & (
  | { initialDate: string; stackId: string; variant?: never }
  | { variant: Variant; initialDate?: never; stackId?: never }
)) {
  const store = habitStore;
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [date, setDate] = useState(initialDate ?? today);
  const [linkedReady, setLinkedReady] = useState(!!initialDate || !!stackId);
  const [day, setDay] = useState<HabitDay | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const embedded = !!initialDate || !!stackId;
  const refresh = useRef<() => void>(() => {});
  const readDay = linkedReady && !(variant && prototypeSection === "system");
  useEffect(() => {
    if (!readDay) return;
    let disposed = false,
      pending = false;
    setDay(null);
    setLoading(true);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await readHabitDay(date);
        if (!disposed) {
          store.merge(result.occurrences);
          setDay(result);
          setError("");
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "Habits unavailable.");
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    };
    refresh.current = () => void load();
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const foreground = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [date, store, readDay]);
  const [selectedStack, setSelectedStack] = useState(stackId);
  useEffect(() => {
    if (initialDate || stackId) return;
    const readLocation = () => {
      const query = new URLSearchParams(window.location.search);
      const value = query.get("date");
      setDate(
        value &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(value))
          ? value
          : today(),
      );
      setSelectedStack(query.get("stack") ?? undefined);
      setLinkedReady(true);
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [initialDate, stackId]);

  const currentDay = day?.today ?? today();
  const occurrences = store.rowsForDate(date);
  const byId = new Map(occurrences.map((r) => [r.habitId, r]));
  const definitions = day?.date === date ? day.projection : null;
  const changeDate = (next: string) => {
    if (next === date) return;
    if (!embedded) {
      const url = new URL(window.location.href);
      url.searchParams.set("date", next);
      url.hash = "";
      window.history.pushState(null, "", url);
    }
    setDay(null);
    setLoading(true);
    setDate(next);
  };

  // Habits visible for this date, grouped by stack, in stack order.
  const groups = (definitions?.stacks ?? [])
    .filter((stack) => !selectedStack || stack.id === selectedStack)
    .map((stack) => {
      const habits = (definitions?.habits ?? []).filter((habit) => {
        if (habit.stack !== stack.id || habit.kind !== "build") return false;
        return (
          byId.has(habit.id) ||
          (isActive(habit, date) && isDue(habit, stack, date))
        );
      });
      return { stack, habits };
    })
    .filter((group) => group.habits.length);

  // "Up next": the first anchored routine still ahead of the Halifax clock today.
  const now = halifaxClock.format(new Date());
  const upNext =
    date === currentDay && !selectedStack
      ? groups
          .filter((g) => g.stack.anchor && g.stack.anchor > now)
          .sort((a, b) => a.stack.anchor!.localeCompare(b.stack.anchor!))[0]
      : undefined;

  if (variant) {
    return (
      <PrototypeShell variant={variant} section={prototypeSection}>
        {prototypeSection === "today" ? (
          <PrototypeToday
            key={date}
            variant={variant}
            groups={groups}
            upcoming={upNext}
            day={day}
            date={date}
            current={currentDay}
            dateLabel={displayDate(date, currentDay)}
            changeDate={changeDate}
            shift={(step) => shiftDate(date, step)}
            loading={loading}
            error={error || day?.error || ""}
            retry={() => refresh.current()}
          />
        ) : (
          <PrototypeGuide
            key={prototypeSection}
            variant={variant}
            section={prototypeSection}
            day={day}
          />
        )}
      </PrototypeShell>
    );
  }

  const controls = (base: Occurrence, name: string) => {
    const row = store.row(base);
    return (
      <chakra.div
        display="inline-flex"
        flexShrink={0}
        overflow="hidden"
        borderRadius="md"
        borderWidth="1px"
        role="group"
        aria-label={`${row.habitId} status`}
      >
        {STATUS_BUTTONS.map(({ status, label: buttonLabel }) => {
          const pressed = row.status === status;
          const disabled =
            !!day?.stale ||
            (status === "skipped" && date < currentDay && !pressed) ||
            // Future days: only declaring (or clearing) a skip, e.g. travel.
            (date > currentDay && status !== "skipped");
          return (
            <Button
              key={status}
              type="button"
              variant="plain"
              minHeight="10"
              borderLeftWidth="1px"
              paddingInline="3"
              fontSize="sm"
              css={{
                _first: { borderLeftWidth: 0 },
                _hover: { background: "bg.muted" },
                _pressed: {
                  background: "colorPalette.solid",
                  color: "colorPalette.contrast",
                },
                _disabled: {
                  opacity: 0.4,
                  _hover: { background: "transparent" },
                },
              }}
              aria-pressed={pressed}
              title={`${name}: ${pressed ? `clear ${buttonLabel.toLowerCase()}` : buttonLabel.toLowerCase()}`}
              disabled={disabled}
              onClick={() =>
                // Tapping the active state again clears it back to open.
                store.edit(base, {
                  status: pressed ? "open" : status,
                  note: store.row(base).note,
                })
              }
            >
              {buttonLabel}
            </Button>
          );
        })}
      </chakra.div>
    );
  };

  const errors = store.errors();
  const tracked = groups.flatMap(({ habits }) =>
    habits.filter((habit) => habit.tracked),
  );
  const logged = tracked.filter((habit) => {
    const row = byId.get(habit.id);
    return row && store.row(row).status !== "open";
  });
  const skipped = logged.filter(
    (habit) => store.row(byId.get(habit.id)!).status === "skipped",
  ).length;
  const content = (
    <Stack width="full" gap="6">
      <Flex
        flexWrap="wrap"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottomWidth="1px"
        paddingBottom="4"
      >
        <Text fontSize="sm" fontWeight="medium">
          <time dateTime={date}>
            {displayDate(date, currentDay)} · {date}
          </time>
        </Text>
        <Flex flexWrap="wrap" alignItems="center" gap="3">
          {tracked.length > 0 && (
            <Text fontSize="sm" color="fg.muted">
              {logged.length} of {tracked.length} logged
              {skipped > 0 ? ` · ${skipped} skipped` : ""}
            </Text>
          )}
          <Button
            type="button"
            variant="plain"
            textUnderlineOffset="4px"
            css={{
              _hover: { textDecoration: "underline" },
              _disabled: { opacity: 0.4, textDecoration: "none" },
            }}
            disabled={!store.canUndo()}
            onClick={store.undo}
          >
            Undo
          </Button>
          <Button
            type="button"
            variant="plain"
            textUnderlineOffset="4px"
            css={{
              _hover: { textDecoration: "underline" },
              _disabled: { opacity: 0.4, textDecoration: "none" },
            }}
            disabled={!store.canRedo()}
            onClick={store.redo}
          >
            Redo
          </Button>
        </Flex>
      </Flex>
      {date < currentDay && (
        <Text fontSize="xs" color="fg.muted">
          Past days can be corrected to Done or Minimum. Skips must be set on or
          before the day.
        </Text>
      )}
      {date > currentDay && (
        <Text fontSize="xs" color="fg.muted">
          For future days, you can plan a Skip. Done and Minimum become
          available on the day.
        </Text>
      )}
      <Flex
        role="status"
        aria-live="polite"
        minHeight="5"
        flexWrap="wrap"
        alignItems="center"
        gap="3"
        fontSize="sm"
        color="fg.muted"
        css={{ _empty: { display: "none" } }}
      >
        {loading && !day ? (
          <span>Loading…</span>
        ) : store.pending() ? (
          <span>Saving…</span>
        ) : null}
      </Flex>
      {(errors.length > 0 || error || day?.error || day?.stale) && (
        <Stack
          borderRadius="md"
          borderWidth="1px"
          padding="3"
          fontSize="sm"
          gap="2"
        >
          {(error || day?.error || day?.stale) && (
            <Text role="alert">
              {error ||
                day?.error ||
                "Habits may be out of date. Refresh before logging."}
            </Text>
          )}
          {errors.map((message) => (
            <Text key={message} role="alert">
              {message}
            </Text>
          ))}
          <Button
            type="button"
            variant="plain"
            minHeight="10"
            borderRadius="md"
            borderWidth="1px"
            paddingInline="3"
            css={{ _hover: { background: "bg.muted" } }}
            onClick={() => {
              store.retry();
              refresh.current();
            }}
          >
            Retry
          </Button>
        </Stack>
      )}

      {groups.map(({ stack, habits }) => (
        <section key={stack.id} aria-labelledby={`stack-${stack.id}`}>
          <chakra.div paddingBottom="2">
            <chakra.h2
              id={`stack-${stack.id}`}
              tabIndex={-1}
              scrollMarginTop="6"
              fontWeight="medium"
            >
              {stack.name}
              {stack.anchor && (
                <chakra.span
                  marginLeft="2"
                  fontFamily="mono"
                  fontSize="sm"
                  fontWeight="normal"
                  color="fg.muted"
                >
                  {displayTime(stack.anchor)}
                </chakra.span>
              )}
            </chakra.h2>
          </chakra.div>
          <chakra.ul
            borderBlockWidth="1px"
            css={{
              "& > :not(:last-child)": {
                borderBottomWidth: "1px",
                borderColor: "border",
              },
            }}
          >
            {habits.map((habit) => {
              const existing = byId.get(habit.id);
              const base: Occurrence = existing ?? {
                habitId: habit.id,
                date,
                definitionSha: day?.sha ?? "",
                status: "open",
                note: "",
                revision: 0,
                missed: false,
              };
              const row = store.row(base);
              const minimum = minimumOf(habit);
              const extra = Object.entries(habit).filter(
                ([k]) => !HIDDEN_HABIT_KEYS.has(k),
              );
              return (
                <chakra.li key={habit.id} paddingBlock="3">
                  <Flex
                    flexWrap="wrap"
                    alignItems="center"
                    justifyContent="space-between"
                    columnGap="4"
                    rowGap="2"
                  >
                    <chakra.div minWidth={0}>
                      <Text fontWeight={habit.tracked ? "medium" : "normal"}>
                        {habit.name}
                        {habit.tracked && row.missed && (
                          <chakra.span
                            marginLeft="2"
                            fontSize="sm"
                            fontWeight="normal"
                            color="fg.muted"
                          >
                            missed
                          </chakra.span>
                        )}
                      </Text>
                      {minimum && (
                        <Text fontSize="sm" color="fg.muted">
                          <chakra.span fontWeight="medium">
                            Minimum:
                          </chakra.span>{" "}
                          {minimum}
                        </Text>
                      )}
                      {!habit.tracked && (
                        <Text fontSize="xs" color="fg.muted">
                          Routine cue · no check-in
                        </Text>
                      )}
                    </chakra.div>
                    {habit.tracked && controls(base, habit.name)}
                  </Flex>
                  {(extra.length > 0 || habit.tracked) && (
                    <chakra.details marginTop="1" fontSize="sm">
                      <chakra.summary
                        width="fit-content"
                        cursor="pointer"
                        listStyleType="none"
                        color="fg.muted"
                        textUnderlineOffset="4px"
                        css={{ _hover: { textDecoration: "underline" } }}
                      >
                        {habit.tracked ? "Details & note" : "Details"}
                      </chakra.summary>
                      <chakra.dl
                        marginTop="2"
                        display="grid"
                        gridTemplateColumns="max-content minmax(0, 1fr)"
                        columnGap="4"
                        rowGap="1"
                      >
                        {extra.map(([k, v]) => (
                          <chakra.div key={k} display="contents">
                            <chakra.dt color="fg.muted">{label(k)}</chakra.dt>
                            <chakra.dd whiteSpace="pre-wrap">
                              {text(v)}
                            </chakra.dd>
                          </chakra.div>
                        ))}
                      </chakra.dl>
                      {habit.tracked && (
                        <HabitNote
                          key={`${habit.id}:${date}`}
                          occurrence={base}
                          disabled={!!day?.stale}
                        />
                      )}
                    </chakra.details>
                  )}
                </chakra.li>
              );
            })}
          </chakra.ul>
        </section>
      ))}

      {!loading && !error && definitions && groups.length === 0 && (
        <Text
          borderRadius="md"
          borderWidth="1px"
          padding="4"
          fontSize="sm"
          color="fg.muted"
        >
          No habits due in this routine on this date.
        </Text>
      )}
      {!loading && tracked.length > 0 && logged.length === tracked.length && (
        <Text fontSize="sm" color="fg.muted">
          All due habits logged{skipped ? `, including ${skipped} skipped` : ""}
          .
        </Text>
      )}

      {!!definitions?.diagnostics.length && (
        <chakra.details fontSize="sm" color="fg.muted">
          <chakra.summary cursor="pointer">
            {definitions.diagnostics.length} habit definition
            {definitions.diagnostics.length === 1 ? " has" : "s have"} problems
            and {definitions.diagnostics.length === 1 ? "is" : "are"} hidden
          </chakra.summary>
          <chakra.ul
            marginTop="2"
            fontFamily="mono"
            fontSize="xs"
            css={{ "& > :not(:last-child)": { marginBottom: "1" } }}
          >
            {definitions.diagnostics.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </chakra.ul>
        </chakra.details>
      )}
    </Stack>
  );
  return content;
}
