"use client";
import { Box, Button, Input, Text, chakra } from "@chakra-ui/react";

// Throwaway visual study on /habits. A maps cues, B opens a field notebook,
// C starts with a conversational command. All interactions are local drafts.
import {
  ArrowDownRightIcon,
  ArrowRightIcon,
  AudioLinesIcon,
  BellIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  LifeBuoyIcon,
  MapPinIcon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { HabitDay, Occurrence } from "./habit-store";
import { prototypeHref } from "./habits-prototype-shell";
import type { Variant } from "./habits-prototype-variant";
import { prototypeStyles as styles } from "./habits-prototype.styles";

const PrototypeLink = chakra(Link);

type Projection = NonNullable<HabitDay["projection"]>;
type Habit = Projection["habits"][number];
type Group = { stack: Projection["stacks"][number]; habits: Habit[] };
type Status = Occurrence["status"];
type Value = { status: Status; note: string };
type Draft = Record<string, Value>;
const choices = [
  { status: "done", label: "Done" },
  { status: "minimum", label: "Minimum" },
  { status: "skipped", label: "Skip" },
] as const;
const statusLabel = {
  open: "",
  done: "Done",
  minimum: "Minimum",
  skipped: "Skipped",
};

function detail(habit: Habit, key: string) {
  const value = (habit as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function clock(value?: string | null) {
  if (!value) return "After its cue";
  const [hour, minute] = value.split(":").map(Number);
  return `${hour! % 12 || 12}:${String(minute).padStart(2, "0")} ${hour! < 12 ? "am" : "pm"}`;
}

export function PrototypeToday({
  variant,
  groups,
  upcoming,
  day,
  date,
  current,
  dateLabel,
  shift,
  changeDate,
  loading,
  error,
  retry,
}: {
  variant: Variant;
  groups: Group[];
  upcoming?: Group;
  day: HabitDay | null;
  date: string;
  current: string;
  dateLabel: string;
  shift: (step: number) => string;
  changeDate: (date: string) => void;
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  const [journal, setJournal] = useState<{ entries: Draft[]; cursor: number }>({
    entries: [{}],
    cursor: 0,
  });
  const [message, setMessage] = useState("");
  const [batch, setBatch] = useState(false);
  const [reminder, setReminder] = useState(false);
  const [selected, setSelected] = useState("");
  const focus =
    groups.find(({ stack }) => stack.id === selected) ??
    upcoming ??
    groups.find(({ habits }) =>
      habits.some(
        (habit) =>
          habit.tracked &&
          day?.occurrences.find((row) => row.habitId === habit.id)?.status ===
            "open",
      ),
    ) ??
    groups[0];
  const tracked = focus?.habits.filter((habit) => habit.tracked) ?? [];
  const isFuture = date > current;
  const edits = journal.entries[journal.cursor] ?? {};
  const plan = tracked.map<{ habit: Habit; status: Status }>((habit, index) => ({
    habit,
    status: index === tracked.length - 1 ? "minimum" : "done",
  }));
  let utterance = "";
  if (tracked.length > 1) {
    utterance = `${focus?.stack.name}: all done. ${tracked.at(-1)?.name} was the minimum.`;
  } else if (tracked.length === 1) {
    utterance = `${tracked[0]?.name}: I did the minimum.`;
  }

  const get = (id: string) =>
    edits[id] ??
    day?.occurrences.find((row) => row.habitId === id) ?? {
      status: "open",
      note: "",
    };

  function commit(patch: Draft, receipt: string) {
    setJournal(({ entries, cursor }) => ({
      entries: [
        ...entries.slice(0, cursor + 1),
        { ...entries[cursor], ...patch },
      ],
      cursor: cursor + 1,
    }));
    setMessage(receipt);
  }
  function history(step: number) {
    setJournal(({ entries, cursor }) => ({ entries, cursor: cursor + step }));
    setMessage(
      step < 0 ? "Undid the last change." : "Restored the last change.",
    );
  }
  function choose(habit: Habit, status: Status) {
    const before = get(habit.id);
    const next = before.status === status ? "open" : status;
    commit(
      { [habit.id]: { status: next, note: before.note } },
      next === "open"
        ? `${habit.name} cleared.`
        : `${habit.name} · ${statusLabel[next]}.`,
    );
  }

  const command = (
    <chakra.section css={styles.command} aria-label="Jarvis batch logging">
      <Box css={styles.commandHead}>
        <AudioLinesIcon size={22} aria-hidden="true" />
        <span>
          Jarvis <small>Voice handoff preview</small>
        </span>
      </Box>
      {groups.length > 1 && (
        <Box css={styles.stackTabs} role="group" aria-label="Choose routine">
          {groups.map(({ stack }) => (
            <Button
              variant="outline"
              size="sm"
              type="button"
              key={stack.id}
              aria-pressed={focus?.stack.id === stack.id}
              onClick={() => {
                setSelected(stack.id);
                setBatch(false);
              }}
            >
              {stack.name}
            </Button>
          ))}
        </Box>
      )}
      {utterance && !isFuture ? (
        <>
          <Text>“{utterance}”</Text>
          <Button
            variant="outline"
            size="sm"
            type="button"
            css={styles.primary}
            onClick={() => setBatch(!batch)}
            aria-expanded={batch}
          >
            {batch ? "Close draft" : "Preview what Jarvis heard"}{" "}
            <CornerDownLeftIcon size={16} aria-hidden="true" />
          </Button>
          {batch && (
            <Box css={styles.batch}>
              <ul>
                {plan.map(({ habit, status }) => (
                  <li key={habit.id}>
                    <span>{habit.name}</span>
                    <b>{statusLabel[status]}</b>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                size="sm"
                type="button"
                css={styles.primary}
                onClick={() => {
                  commit(
                    Object.fromEntries(
                      plan.map(({ habit, status }) => [
                        habit.id,
                        { status, note: get(habit.id).note },
                      ]),
                    ),
                    `${focus?.stack.name} logged in preview.`,
                  );
                  setBatch(false);
                }}
              >
                Apply sample batch
              </Button>
            </Box>
          )}
        </>
      ) : (
        <Text>
          {isFuture
            ? "Future days are available for planned skips."
            : "A tracked routine will show a sample voice phrase here."}
        </Text>
      )}
    </chakra.section>
  );

  function renderGroup(group: Group, mode: "path" | "notes" | "compact") {
    return (
      <chakra.section
        key={group.stack.id}
        css={styles.routine}
        data-mode={mode}
        aria-label={group.stack.name}
      >
        <Box css={styles.routineHead}>
          <Box>
            <chakra.span css={styles.kicker}>
              <MapPinIcon size={14} aria-hidden="true" />{" "}
              {clock(group.stack.anchor)}
            </chakra.span>
            <h2>{group.stack.name}</h2>
          </Box>
          <chakra.span css={styles.routineLabel}>Cue chain</chakra.span>
        </Box>
        <chakra.ol css={styles.steps}>
          {group.habits.map((habit, index) => {
            const value = get(habit.id);
            const floor = detail(habit, "minimum");
            const full = detail(habit, "full");
            const fallback = detail(habit, "fallback");
            const identity = detail(habit, "identity");
            const other = ["environment", "reward", "replacement"].filter(
              (key) => detail(habit, key),
            );
            const cue =
              detail(habit, "cue") ||
              (index > 0
                ? `After ${group.habits[index - 1]?.name}`
                : group.stack.cue || "At the routine anchor");
            return (
              <chakra.li
                key={habit.id}
                css={styles.step}
                data-status={value.status}
              >
                <chakra.span css={styles.node} aria-hidden="true">
                  {value.status === "done" || value.status === "minimum" ? (
                    <CheckIcon size={13} />
                  ) : (
                    <span />
                  )}
                </chakra.span>
                <Box css={styles.stepText}>
                  <Text css={styles.cue}>{cue}</Text>
                  <h3>
                    {habit.name}
                    {habit.tracked && value.status !== "open" && (
                      <chakra.span css={styles.receipt}>
                        {statusLabel[value.status]}
                      </chakra.span>
                    )}
                  </h3>
                  {floor && (
                    <Text css={styles.floor}>
                      <b>Minimum</b> {floor}
                    </Text>
                  )}
                  {fallback && (
                    <Text css={styles.fallback}>
                      <ArrowDownRightIcon size={14} aria-hidden="true" />{" "}
                      <span>{fallback}</span>
                    </Text>
                  )}
                  {(full || identity || other.length > 0 || habit.tracked) && (
                    <chakra.details css={styles.details}>
                      <chakra.summary>
                        {habit.tracked ? "Details & note" : "Details"}
                      </chakra.summary>
                      {full && (
                        <Text>
                          <b>Full version</b> {full}
                        </Text>
                      )}
                      {identity && (
                        <Text>
                          <b>Identity</b> {identity}
                        </Text>
                      )}
                      {other.map((key) => (
                        <Text key={key}>
                          <b>{key}</b> {detail(habit, key)}
                        </Text>
                      ))}
                      {habit.tracked && (
                        <label>
                          Note{" "}
                          <Input
                            type="text"
                            maxLength={4000}
                            aria-label={`Note for ${habit.name}`}
                            key={value.note}
                            defaultValue={value.note}
                            onBlur={(event) => {
                              if (event.target.value !== value.note)
                                commit(
                                  {
                                    [habit.id]: {
                                      status: value.status,
                                      note: event.target.value,
                                    },
                                  },
                                  `${habit.name} note updated.`,
                                );
                            }}
                          />
                        </label>
                      )}
                    </chakra.details>
                  )}
                </Box>
                {habit.tracked && (
                  <Box
                    css={styles.actions}
                    role="group"
                    aria-label={`Log ${habit.name}`}
                  >
                    {choices.map(({ status, label }) => (
                      <Button
                        variant="outline"
                        size="sm"
                        key={status}
                        type="button"
                        aria-pressed={value.status === status}
                        disabled={
                          (isFuture && status !== "skipped") ||
                          (date < current &&
                            status === "skipped" &&
                            value.status !== "skipped")
                        }
                        onClick={() => choose(habit, status)}
                      >
                        {label}
                      </Button>
                    ))}
                  </Box>
                )}
              </chakra.li>
            );
          })}
        </chakra.ol>
      </chakra.section>
    );
  }

  const rescue = (
    <PrototypeLink
      href={prototypeHref(variant, "playbook")}
      css={styles.rescue}
    >
      <LifeBuoyIcon size={20} aria-hidden="true" />
      <span>
        <b>Having an urge?</b>
        <small>Get one next move</small>
      </span>
      <ArrowRightIcon size={16} aria-hidden="true" />
    </PrototypeLink>
  );
  const reminderPreview = focus && (
    <Box css={styles.reminder}>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => setReminder(!reminder)}
        aria-expanded={reminder}
      >
        <BellIcon size={16} aria-hidden="true" />{" "}
        {reminder ? "Hide reminder preview" : "Preview the cue reminder"}
      </Button>
      {reminder && (
        <blockquote>
          <b>
            {focus.stack.name} · {clock(focus.stack.anchor)}
          </b>
          <Text>
            {focus.habits
              .map((habit) =>
                [habit.name, detail(habit, "minimum")]
                  .filter(Boolean)
                  .join(" — "),
              )
              .join(" → ")}
          </Text>
          {focus.habits
            .filter(
              (habit) =>
                detail(habit, "fallbackAt") && detail(habit, "fallback"),
            )
            .map((habit) => (
              <Text key={habit.id}>
                <b>Plan B · {clock(detail(habit, "fallbackAt"))}</b>{" "}
                {detail(habit, "fallback")}
              </Text>
            ))}
        </blockquote>
      )}
    </Box>
  );

  return (
    <>
      <Box css={styles.utility}>
        <Box css={styles.date} aria-label="Choose habit day">
          <Button
            variant="outline"
            size="sm"
            type="button"
            aria-label="Previous day"
            onClick={() => changeDate(shift(-1))}
          >
            <ChevronLeftIcon size={16} />
          </Button>
          <label>
            <span>{dateLabel}</span>
            <Input
              type="date"
              aria-label="Habit date"
              value={date}
              onChange={(e) => e.target.value && changeDate(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            type="button"
            aria-label="Next day"
            onClick={() => changeDate(shift(1))}
          >
            <ChevronRightIcon size={16} />
          </Button>
        </Box>
        <Box css={styles.history}>
          <span role="status">{message}</span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={journal.cursor === 0}
            onClick={() => history(-1)}
            aria-label="Undo"
          >
            <Undo2Icon size={16} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={journal.cursor === journal.entries.length - 1}
            onClick={() => history(1)}
            aria-label="Redo"
          >
            <Redo2Icon size={16} />
          </Button>
        </Box>
      </Box>
      {error && (
        <Text role="alert" css={styles.banner}>
          {error}{" "}
          <Button variant="outline" size="sm" type="button" onClick={retry}>
            Retry
          </Button>
        </Text>
      )}
      {loading && !day && (
        <Text role="status" css={styles.banner}>
          Loading routines…
        </Text>
      )}
      {!loading && !groups.length && !error && (
        <Text css={styles.banner}>No routine on this day.</Text>
      )}
      {variant === "A" && (
        <>
          <Box css={styles.mapHero}>
            <Box>
              <Text css={styles.kicker}>
                {upcoming?.stack.id === focus?.stack.id && upcoming
                  ? "Up next"
                  : "Your cue card"}
              </Text>
              <h1>{focus?.stack.name ?? "Follow the cue."}</h1>
              {focus ? (
                <>
                  <Text>
                    {clock(focus.stack.anchor)} ·{" "}
                    {detail(focus.habits[0]!, "cue") ||
                      focus.stack.cue ||
                      "At the routine anchor"}
                  </Text>
                  <Text css={styles.heroFloor}>
                    {focus.habits[0]?.name}
                    {detail(focus.habits[0]!, "minimum") &&
                      ` · Minimum: ${detail(focus.habits[0]!, "minimum")}`}
                  </Text>
                </>
              ) : (
                <Text>Your routine starts with a single cue.</Text>
              )}
            </Box>
            <Box css={styles.mapArt} aria-hidden="true">
              <svg viewBox="0 0 340 144" fill="none">
                <path
                  d="M-8 121H46C77 121 79 31 124 31H184C216 31 215 110 254 110H350"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M-8 132H46C86 132 83 42 124 42H184C211 42 207 121 254 121H350"
                  stroke="currentColor"
                  strokeOpacity=".23"
                  strokeDasharray="3 5"
                />
                <circle
                  cx="46"
                  cy="121"
                  r="8"
                  fill="#eaf2ff"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <circle
                  cx="154"
                  cy="31"
                  r="8"
                  fill="#eaf2ff"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <circle cx="267" cy="110" r="8" fill="currentColor" />
              </svg>
            </Box>
          </Box>
          <Box css={styles.mapTools}>
            {reminderPreview}
            {rescue}
          </Box>
          <Box css={styles.mapBody}>
            <Box css={styles.routines}>
              {groups.map((group) => renderGroup(group, "path"))}
            </Box>
            {command}
          </Box>
        </>
      )}
      {variant === "B" && (
        <Box css={styles.notebook}>
          <Box css={styles.notebookMain}>
            <Text css={styles.kicker}>A page for the day</Text>
            <h1>Routines</h1>
            <Text css={styles.lede}>
              Start with the cue. The minimum counts.
            </Text>
            {groups.map((group) => renderGroup(group, "notes"))}
          </Box>
          <chakra.aside css={styles.margins} aria-label="Field notes margin">
            {rescue}
            {focus && (
              <Box css={styles.marginNote}>
                <Text css={styles.kicker}>
                  {upcoming ? "Next anchor" : "Cue to revisit"}
                </Text>
                <h2>{focus.stack.name}</h2>
                <Text>
                  {clock(focus.stack.anchor)} · {focus.habits[0]?.name}
                </Text>
                {reminderPreview}
              </Box>
            )}
            {command}
          </chakra.aside>
        </Box>
      )}
      {variant === "C" && (
        <Box css={styles.console}>
          <Box css={styles.consoleHero}>
            <Box>
              <Text css={styles.kicker}>Daily handoff</Text>
              <h1>Close the loop.</h1>
              <Text css={styles.lede}>
                Say how the routine went in one sentence.
              </Text>
            </Box>
            {rescue}
          </Box>
          {command}
          <Box css={styles.consoleTools}>{reminderPreview}</Box>
          {focus && renderGroup(focus, "compact")}
        </Box>
      )}
    </>
  );
}
