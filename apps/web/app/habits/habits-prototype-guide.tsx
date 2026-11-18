"use client";
import { FilterSelect } from "@/components/shared/filter-select";
import { Box, Button, Text, chakra } from "@chakra-ui/react";

import {
  ArrowDownRight,
  ArrowRight,
  BookOpen,
  Check,
  Circle,
  Clock3,
  Compass,
  Copy,
  Flag,
  Footprints,
  Moon,
  Sun,
  Timer,
} from "lucide-react";
import { useEffect, useState } from "react";
import { HabitMarkdown } from "./habit-markdown";
import { habitClient } from "./habits-api";
import type { operations } from "@/lib/generated/quantself-api-schema";
import type { HabitDay } from "./habit-store";
import { guideStyles as styles } from "./habits-prototype.styles";

type Variant = "A" | "B" | "C";

const dayTypes = [
  ["Job days", "Job only", "Keep the rest of the day free for recovery."],
  [
    "Free days",
    "Business → client work",
    "15 min of business first. 30 min of client work after.",
  ],
  [
    "Sunday",
    "Review only",
    "Find the friction. Choose one fix for the coming week.",
  ],
] as const;
const signals = ["Hungry", "Angry or anxious", "Lonely", "Tired"] as const;
const situations = [
  ["Phone in hand after 9 pm", "Walk it to the kitchen charger now."],
  [
    "Alone, bored and up late",
    "Turn on a light, stand up, go outside for two minutes, then text someone and reach for the book.",
  ],
  ["Stressed after work", "Take a ten-minute walk before doing anything else."],
  [
    "Hungry with nothing prepped",
    "Reach for fruit or a simple whole-food snack.",
  ],
  ["In the supermarket", "Stick to the list. Eat before heading out."],
  [
    "Reaching for the phone between tasks",
    "Open the ideas note and write one post idea.",
  ],
  [
    "Reinstalled an app",
    "Delete it now and bring the environment failure to Sunday review.",
  ],
] as const;
const replacements = [
  "Drink water",
  "Step outside for two minutes",
  "Text a friend",
  "Write a post idea",
] as const;
const eventTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

export function PrototypeGuide({
  variant,
  section,
  day,
}: {
  variant: Variant;
  section: "system" | "playbook";
  day: HabitDay | null;
}) {
  return (
    <chakra.section
      css={styles.guide}
      data-guide-variant={variant}
      aria-labelledby="prototype-guide-title"
    >
      {section === "system" ? <SystemGuide /> : <PlaybookGuide day={day} />}
    </chakra.section>
  );
}

function SourceDocument({
  path,
  label = "Read the source Markdown",
}: {
  path: string;
  label?: string;
}) {
  const [document, setDocument] = useState<{ text: string; error?: string }>();
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const { data, error } = await habitClient.GET("/api/v1/habits/document", {
        params: { query: { path } },
      });
      setDocument({
        text: data?.text ?? "",
        error:
          error?.message ??
          data?.error ??
          (data?.stale ? "Source may be out of date." : undefined),
      });
    } catch {
      setDocument({ text: "", error: "Source unavailable." });
    } finally {
      setLoading(false);
    }
  }
  return (
    <chakra.details
      css={styles.source}
      onToggle={(event) => {
        if (event.currentTarget.open && !document && !loading) void load();
      }}
    >
      <chakra.summary>
        <BookOpen size={16} aria-hidden="true" /> {label}
      </chakra.summary>
      {loading ? (
        <Text role="status">Loading source…</Text>
      ) : document?.text ? (
        <Box css={styles.sourceText}>
          {document.error && <Text role="status">{document.error}</Text>}
          <HabitMarkdown>{document.text}</HabitMarkdown>
        </Box>
      ) : document ? (
        <Text>
          {document.error ?? "No source document is available."}{" "}
          <Button
            variant="outline"
            size="sm"
            type="button"
            css={styles.link}
            onClick={() => void load()}
          >
            Retry
          </Button>
        </Text>
      ) : null}
    </chakra.details>
  );
}

function PastReviews() {
  const [paths, setPaths] = useState<string[]>();
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load(offset = 0) {
    setLoading(true);
    setError("");
    try {
      const { data } = await habitClient.GET("/api/v1/habits/reviews", {
        params: { query: { offset } },
      });
      if (!data || data.error)
        throw new Error(data?.error ?? "Past reviews unavailable.");
      setPaths((previous) =>
        offset
          ? [...new Set([...(previous ?? []), ...data.paths])]
          : data.paths,
      );
      setNext(data.next ?? null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Past reviews unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <chakra.details
      css={styles.source}
      onToggle={(event) => {
        if (event.currentTarget.open && !paths && !loading && !error)
          void load();
      }}
    >
      <chakra.summary>
        <Flag size={16} aria-hidden="true" /> Past reviews
      </chakra.summary>
      {paths?.length === 0 && <Text>No past reviews yet.</Text>}
      {paths?.map((path) => (
        <SourceDocument
          key={path}
          path={path}
          label={path.replace(/^reviews\//, "").replace(/\.md$/, "")}
        />
      ))}
      {loading && <Text role="status">Loading reviews…</Text>}
      {error && <Text role="status">{error}</Text>}
      {(next !== null || error) && (
        <Button
          variant="outline"
          size="sm"
          type="button"
          css={styles.link}
          disabled={loading}
          onClick={() => void load(next ?? 0)}
        >
          {error ? "Retry reviews" : "Older reviews"}
        </Button>
      )}
    </chakra.details>
  );
}

type Slip =
  operations["listHabitSlips"]["responses"][200]["content"]["application/json"]["slips"][number];

function UrgeHistory({ day }: { day: HabitDay | null }) {
  const [slips, setSlips] = useState<Slip[]>();
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const names = new Map(
    day?.projection?.habits.map((habit) => [habit.id, habit.name]),
  );
  async function load(before?: string) {
    setLoading(true);
    setError("");
    try {
      const { data } = await habitClient.GET("/api/v1/habits/slips", {
        params: { query: { before } },
      });
      if (!data) throw new Error("Recent urges unavailable.");
      setSlips((previous) => [
        ...(before ? (previous ?? []) : []),
        ...data.slips,
      ]);
      setNext(data.next ?? undefined);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Recent urges unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <chakra.details
      css={styles.source}
      onToggle={(event) => {
        if (event.currentTarget.open && !slips && !loading && !error)
          void load();
      }}
    >
      <chakra.summary>
        <Clock3 size={16} aria-hidden="true" /> Recent urges
      </chakra.summary>
      {slips?.length === 0 && <Text>No urges logged yet.</Text>}
      <chakra.ul css={styles.history}>
        {slips?.map((slip) => (
          <li key={slip.id}>
            <strong>{names.get(slip.habitId) ?? slip.habitId}</strong>
            <span>
              {slip.outcome}
              {slip.trigger && ` · ${slip.trigger}`}
            </span>
            <time dateTime={slip.occurredAt}>
              {eventTime.format(new Date(slip.occurredAt))}
            </time>
            {slip.note && <Text>{slip.note}</Text>}
          </li>
        ))}
      </chakra.ul>
      {loading && <Text role="status">Loading urges…</Text>}
      {error && <Text role="status">{error}</Text>}
      {(next || error) && (
        <Button
          variant="outline"
          size="sm"
          type="button"
          css={styles.link}
          disabled={loading}
          onClick={() => void load(next)}
        >
          {error ? "Retry urges" : "Older urges"}
        </Button>
      )}
    </chakra.details>
  );
}

function SystemGuide() {
  const [selectedDay, setSelectedDay] = useState(1);
  const [copied, setCopied] = useState("");
  const selected = dayTypes[selectedDay]!;
  async function copyReviewPrompt() {
    try {
      await navigator.clipboard.writeText(
        "Add the observation I describe next to my Sunday review inbox. Capture what happened, which cue or environmental setup got in the way, and the smallest change worth discussing on Sunday. Leave the current system in effect.",
      );
      setCopied(
        "Prompt copied. Paste it into your AI chat and describe what happened.",
      );
    } catch {
      setCopied(
        "Clipboard unavailable. Tell Jarvis to capture what happened for your Sunday review.",
      );
    }
  }
  return (
    <>
      <chakra.header css={styles.hero}>
        <Text css={styles.eyebrow}>
          <Compass size={15} aria-hidden="true" /> My system
        </Text>
        <h1 id="prototype-guide-title">The week is already decided.</h1>
        <Text>
          Pick the day type. Keep the anchors. Change one thing on Sunday.
        </Text>
      </chakra.header>
      <Text css={styles.sample}>Preview based on the system design notes</Text>
      <Box css={styles.systemGrid}>
        <chakra.section css={styles.panel} aria-labelledby="guide-day-types">
          <h2 id="guide-day-types">How the week works</h2>
          <Box css={styles.choices} role="group" aria-label="Day type">
            {dayTypes.map(([type], index) => (
              <Button
                variant="outline"
                size="sm"
                type="button"
                key={type}
                aria-pressed={selectedDay === index}
                onClick={() => setSelectedDay(index)}
              >
                {type}
              </Button>
            ))}
          </Box>
          <Box css={styles.decision} aria-live="polite">
            <ArrowDownRight size={21} aria-hidden="true" />
            <Box>
              <h3>{selected[1]}</h3>
              <Text>{selected[2]}</Text>
            </Box>
          </Box>
        </chakra.section>
        <chakra.section css={styles.panel} aria-labelledby="guide-anchors">
          <h2 id="guide-anchors">Fixed anchors</h2>
          <chakra.ul css={styles.anchors}>
            <li>
              <Sun size={19} aria-hidden="true" />
              <Box>
                <h3>6:30 am · Morning</h3>
                <Text>Drink water, then pick a way to get outside.</Text>
              </Box>
            </li>
            <li>
              <Moon size={19} aria-hidden="true" />
              <Box>
                <h3>9:30 pm · Lights out</h3>
                <Text>9:00 screens off → 9:15 phone parked.</Text>
              </Box>
            </li>
            <li>
              <Flag size={19} aria-hidden="true" />
              <Box>
                <h3>Sunday evening · Review</h3>
                <Text>Ten minutes to find one change.</Text>
              </Box>
            </li>
          </chakra.ul>
        </chakra.section>
        <chakra.section css={styles.panel} aria-labelledby="guide-floor">
          <Text css={styles.eyebrow}>
            <Footprints size={15} aria-hidden="true" /> Worst-day floor
          </Text>
          <h2 id="guide-floor">Five minutes outside.</h2>
          <Text>
            Before 7:30 am. Walking, running and breathing outside all serve the
            same anchor.
          </Text>
        </chakra.section>
        <chakra.section css={styles.panel} aria-labelledby="guide-review-dates">
          <Text css={styles.eyebrow}>
            <Clock3 size={15} aria-hidden="true" /> Review dates
          </Text>
          <h2 id="guide-review-dates">Give temporary work an end.</h2>
          <chakra.dl css={styles.reviewDates}>
            <Box>
              <dt>Nov 15</dt>
              <dd>Stop the job applications block.</dd>
            </Box>
            <Box>
              <dt>Nov 30</dt>
              <dd>Decide whether old client work can wrap or shrink.</dd>
            </Box>
          </chakra.dl>
        </chakra.section>
      </Box>
      <Box css={styles.systemGrid}>
        <chakra.section css={styles.panel} aria-labelledby="guide-fallbacks">
          <Text css={styles.eyebrow}>
            <ArrowDownRight size={15} aria-hidden="true" /> Plan B
          </Text>
          <h2 id="guide-fallbacks">When the day goes sideways</h2>
          <chakra.dl css={styles.fallbacks}>
            <Box>
              <dt>Missed morning outside?</dt>
              <dd>Go outside at lunch.</dd>
            </Box>
            <Box>
              <dt>Work runs late?</dt>
              <dd>Close at nine and note where to restart.</dd>
            </Box>
            <Box>
              <dt>Two misses in a row?</dt>
              <dd>Do the minimum next time. Bring the friction to Sunday.</dd>
            </Box>
          </chakra.dl>
        </chakra.section>
        <chakra.section css={styles.panel} aria-labelledby="guide-inbox">
          <Text css={styles.eyebrow}>
            <BookOpen size={15} aria-hidden="true" /> Review inbox
          </Text>
          <h2 id="guide-inbox">Hold that thought for Sunday.</h2>
          <Text>
            Tell Jarvis what got in the way. Review the idea alongside the
            week’s observations and choose one change.
          </Text>
          <Button
            variant="outline"
            size="sm"
            type="button"
            css={styles.link}
            onClick={() => void copyReviewPrompt()}
          >
            <Copy size={16} aria-hidden="true" /> Copy review inbox prompt
          </Button>
          <Text role="status">{copied}</Text>
        </chakra.section>
      </Box>
      <SourceDocument path="SYSTEM.md" />
      <PastReviews />
    </>
  );
}

function PlaybookGuide({ day }: { day: HabitDay | null }) {
  const [flags, setFlags] = useState<string[]>([]);
  const [situation, setSituation] = useState<number>();
  const [move, setMove] = useState("");
  const [deadline, setDeadline] = useState<number>();
  const [seconds, setSeconds] = useState(600);
  const [decided, setDecided] = useState(false);
  const [breakHabitId, setBreakHabitId] = useState("");
  const [outcome, setOutcome] = useState("");
  const breakHabits =
    day?.projection?.habits.filter((habit) => habit.kind === "break") ?? [];
  const fastTrack = flags.length >= 2;
  const running = deadline !== undefined && seconds > 0;
  useEffect(() => {
    if (deadline === undefined) return;
    const interval = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(remaining);
      if (!remaining) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [deadline]);

  function reset() {
    setFlags([]);
    setSituation(undefined);
    setMove("");
    setDeadline(undefined);
    setSeconds(600);
    setDecided(false);
    setBreakHabitId("");
    setOutcome("");
  }

  return (
    <>
      <chakra.header css={styles.hero}>
        <Text css={styles.eyebrow}>
          <Compass size={15} aria-hidden="true" /> Temptation playbook
        </Text>
        <h1 id="prototype-guide-title">
          {fastTrack
            ? "Go straight to a replacement."
            : "Give the urge ten minutes."}
        </h1>
        <Text>
          {fastTrack
            ? "Two warning signs are enough. Pick a small move below."
            : "Say it out loud. “I want to do this because I feel…”"}
        </Text>
        <chakra.a css={styles.heroAction} href="#guide-replacement">
          Choose a replacement <ArrowDownRight size={16} aria-hidden="true" />
        </chakra.a>
      </chakra.header>
      <chakra.ol css={styles.protocol} aria-label="Urge protocol">
        {[
          ["Name it", fastTrack ? "Skip" : "Say the urge out loud"],
          ["Replace it", move || "Pick one small move"],
          [
            "Wait",
            deadline === undefined
              ? "Take ten minutes"
              : seconds > 0
                ? "Timer running"
                : "Time is up",
          ],
          [
            "Decide",
            decided ? "Keep the next plan" : "Choose what happens next",
          ],
        ].map(([name, detail], index) => (
          <li key={name}>
            <span aria-hidden="true">{index + 1}</span>
            <Box>
              <strong>{name}</strong>
              <small>{detail}</small>
            </Box>
          </li>
        ))}
      </chakra.ol>
      <Box css={styles.playGrid}>
        <chakra.section css={styles.panel} aria-labelledby="guide-replacement">
          <h2 id="guide-replacement">One small move</h2>
          <Box
            css={styles.choices}
            role="group"
            aria-label="Replacement actions"
          >
            {replacements.map((item) => (
              <Button
                variant="outline"
                size="sm"
                type="button"
                key={item}
                aria-pressed={move === item}
                onClick={() => setMove(item)}
              >
                {item}
              </Button>
            ))}
          </Box>
          <Box css={styles.timer}>
            <chakra.span css={styles.time} aria-label="Time remaining">
              <Timer size={17} aria-hidden="true" /> {Math.floor(seconds / 60)}:
              {String(seconds % 60).padStart(2, "0")}
            </chakra.span>
            {running ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                css={styles.link}
                onClick={() => {
                  setDeadline(undefined);
                  setSeconds(600);
                }}
              >
                Reset timer
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                type="button"
                css={styles.link}
                onClick={() => {
                  setSeconds(600);
                  setDeadline(Date.now() + 600_000);
                }}
              >
                Start ten-minute timer
              </Button>
            )}
          </Box>
          <Text role="status">
            {deadline !== undefined && seconds === 0
              ? "Ten minutes passed. Decide what you want to do next."
              : ""}
          </Text>
          <Button
            variant="outline"
            size="sm"
            type="button"
            css={styles.link}
            onClick={() => setDecided(true)}
          >
            Ready to decide <ArrowRight size={15} aria-hidden="true" />
          </Button>
          {decided && (
            <Text css={styles.decision} role="status">
              <Check size={19} aria-hidden="true" /> Do the next planned thing
              on time.
            </Text>
          )}
        </chakra.section>
        <chakra.section css={styles.panel} aria-labelledby="guide-halt">
          <h2 id="guide-halt">Notice your signals</h2>
          <Text>With two present, go straight to the replacement.</Text>
          <Box css={styles.choices} role="group" aria-label="Warning signs">
            {signals.map((signal) => (
              <Button
                variant="outline"
                size="sm"
                type="button"
                key={signal}
                aria-pressed={flags.includes(signal)}
                onClick={() =>
                  setFlags((current) =>
                    current.includes(signal)
                      ? current.filter((item) => item !== signal)
                      : [...current, signal],
                  )
                }
              >
                {signal}
              </Button>
            ))}
          </Box>
          {fastTrack && (
            <Text role="status" css={styles.signal}>
              <ArrowDownRight size={16} aria-hidden="true" /> Go to your
              replacement.
            </Text>
          )}
        </chakra.section>
        <chakra.section css={styles.panel} aria-labelledby="guide-situation">
          <h2 id="guide-situation">If this happens</h2>
          <Box css={styles.choices} role="group" aria-label="Situations">
            {situations.map(([label], index) => (
              <Button
                variant="outline"
                size="sm"
                type="button"
                key={label}
                aria-pressed={situation === index}
                onClick={() => setSituation(index)}
              >
                {label}
              </Button>
            ))}
          </Box>
          {situation !== undefined && (
            <Text css={styles.decision} role="status">
              <ArrowDownRight size={18} aria-hidden="true" />
              {situations[situation]?.[1]}
            </Text>
          )}
        </chakra.section>
      </Box>
      <chakra.details css={styles.source}>
        <chakra.summary>
          <Circle size={15} aria-hidden="true" /> Record how it went · optional
        </chakra.summary>
        <Box css={styles.log}>
          <div>
            Break habit
            <FilterSelect
              label="Break habit"
              size="md"
              highlightActive={false}
              value={breakHabitId}
              onChange={(value) => {
                setBreakHabitId(value);
                setOutcome("");
              }}
              items={[
                { value: "", label: "Choose a habit" },
                ...(breakHabits.length
                  ? breakHabits
                  : [
                      { id: "phone", name: "Short-form content · sample" },
                      { id: "food", name: "Processed food · sample" },
                    ]
                ).map((habit) => ({ value: habit.id, label: habit.name })),
              ]}
            />
          </div>
          <Box css={styles.choices} role="group" aria-label="Urge outcome">
            {["Resisted", "Slipped"].map((value) => (
              <Button
                variant="outline"
                size="sm"
                type="button"
                key={value}
                disabled={!breakHabitId}
                aria-pressed={outcome === value}
                onClick={() => setOutcome(value)}
              >
                {value}
              </Button>
            ))}
          </Box>
          <Text role="status">
            {outcome
              ? `${outcome} · recorded in this preview only.`
              : "Preview only. Nothing is saved."}
          </Text>
        </Box>
      </chakra.details>
      <SourceDocument path="playbook.md" />
      <UrgeHistory day={day} />
      <Button
        variant="outline"
        size="sm"
        type="button"
        css={styles.link}
        onClick={reset}
      >
        Reset playbook
      </Button>
    </>
  );
}
