"use client";

import { FilterSelect } from "@/components/shared/filter-select";
import { Box, Button, Field, Flex, Grid, Heading, Input, Text } from "@chakra-ui/react";
import { useEffect, useState, useTransition } from "react";
import {
  createRemedyIntakeFromBrowser,
  deleteRemedyIntakeFromBrowser,
  listRemedyIntakesFromBrowser,
} from "@/lib/quantself-api-browser";
import type {
  InventoryItem,
  RemedyIntake,
  RemedyIntakeProjection,
} from "@/lib/quantself-api-client";

type RemedyOption = Pick<
  InventoryItem,
  "archivedAt" | "id" | "remedyProfile" | "title"
>;

export type RemedyIntakeRange = "7d" | "30d" | "90d" | "all";

const remedyRangeOptions: Array<{ label: string; value: RemedyIntakeRange }> = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "all" },
];
const remedyLaneColors = [
  "green.500",
  "blue.500",
  "orange.500",
  "pink.500",
  "cyan.500",
  "teal.500",
  "purple.500",
  "yellow.500",
];

type RemedyTimelineIntake = RemedyIntake &
  Partial<Pick<RemedyIntakeProjection, "bucketDate" | "colorKey">>;

export function RemedyIntakePanel({
  initialIntakes,
  nowIso,
  range,
  remedies,
  searchQuery = "",
  timeZone,
}: {
  initialIntakes: RemedyTimelineIntake[];
  nowIso: string;
  range: RemedyIntakeRange;
  remedies: RemedyOption[];
  searchQuery?: string;
  timeZone?: string;
}) {
  const [activeTimeZone, setActiveTimeZone] = useState(() =>
    normalizeRemedyTimeZone(timeZone ?? "UTC"),
  );
  const [intakes, setIntakes] = useState(initialIntakes);
  const [historyStatus, setHistoryStatus] = useState<
    "error" | "idle" | "loading"
  >("idle");
  const [feedback, setFeedback] = useState<{
    message: string;
    status: "error" | "idle" | "success";
  }>({
    message: "",
    status: "idle",
  });
  const [isPending, startTransition] = useTransition();
  const [selectedItemId, setSelectedItemId] = useState(remedies[0]?.id ?? "");
  const [selectedPotency, setSelectedPotency] = useState(
    remedies[0]?.remedyProfile?.potencies[0] ?? "",
  );
  const [occurredAt, setOccurredAt] = useState(() =>
    formatDateTimeLocalValue(new Date()),
  );
  const [note, setNote] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  const selectedRemedy =
    remedies.find((remedy) => remedy.id === selectedItemId) ?? remedies[0] ?? null;
  const potencyOptions = selectedRemedy?.remedyProfile?.potencies ?? [];
  const visibleIntakes = filterRemedyIntakesByRange(
    intakes,
    range,
    nowIso,
    activeTimeZone,
  );
  const timeline = buildRemedyTimeline({
    intakes: visibleIntakes,
    nowIso,
    range,
    remedies,
    timeZone: activeTimeZone,
  });

  useEffect(() => {
    const nextTimeZone = normalizeRemedyTimeZone(timeZone);
    setActiveTimeZone(nextTimeZone);

    if (!timeZone && nextTimeZone !== "UTC") {
      window.history.replaceState(
        null,
        "",
        buildRemedyRangeHref(range, searchQuery, nextTimeZone),
      );
    }

    if (timeZone || nextTimeZone === "UTC") {
      return;
    }

    let cancelled = false;
    setHistoryStatus("loading");
    void listRemedyIntakesFromBrowser({ range, timeZone: nextTimeZone })
      .then((nextIntakes) => {
        if (cancelled) {
          return;
        }
        setIntakes(nextIntakes);
        setHistoryStatus("idle");
      })
      .catch(() => {
        if (!cancelled) {
          setHistoryStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [range, searchQuery, timeZone]);

  useEffect(() => {
    if (!selectedRemedy) {
      setSelectedItemId("");
      setSelectedPotency("");
      return;
    }

    if (selectedItemId !== selectedRemedy.id) {
      setSelectedItemId(selectedRemedy.id);
    }

    if (!potencyOptions.includes(selectedPotency)) {
      setSelectedPotency(potencyOptions[0] ?? "");
    }
  }, [potencyOptions, selectedPotency, selectedItemId, selectedRemedy]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedRemedy || !selectedPotency) {
      setFeedback({
        message: "Choose an active remedy and potency.",
        status: "error",
      });
      return;
    }

    startTransition(async () => {
      try {
        const intake = await createRemedyIntakeFromBrowser({
          note: note.trim() ? note.trim() : null,
          occurredAt: occurredAt
            ? new Date(occurredAt).toISOString()
            : undefined,
          potency: selectedPotency,
          itemId: selectedRemedy.id,
        });

        setIntakes((current) => [intake, ...current.filter((entry) => entry.id !== intake.id)]);
        setFeedback({
          message: "Remedy intake recorded.",
          status: "success",
        });
        setNote("");
        setOccurredAt(formatDateTimeLocalValue(new Date()));
      } catch (error) {
        setFeedback({
          message:
            error instanceof Error ? error.message : "Could not record remedy intake.",
          status: "error",
        });
      }
    });
  }

  function confirmDelete(intakeId: string) {
    setConfirmingDeleteId((current) => (current === intakeId ? null : intakeId));
  }

  function removeIntake(intakeId: string) {
    startTransition(async () => {
      try {
        await deleteRemedyIntakeFromBrowser(intakeId);
        setIntakes((current) => current.filter((intake) => intake.id !== intakeId));
        setConfirmingDeleteId(null);
        setFeedback({
          message: "Remedy intake deleted.",
          status: "success",
        });
      } catch (error) {
        setFeedback({
          message:
            error instanceof Error ? error.message : "Could not delete remedy intake.",
          status: "error",
        });
      }
    });
  }

  return (
    <Grid as="section" minW="0" gap="4" rounded="xl" borderWidth="1px" bg="bg" p="4" shadow="xs">
      <Grid gap="1">
        <Flex wrap="wrap" align="start" justify="space-between" gap="3">
          <Grid gap="1">
            <Heading as="h2" size="sm">Remedy timeline</Heading>
            <Text color="fg.muted" textStyle="sm">
              Stable lanes, totals, and time-range filters for owned remedies.
            </Text>
          </Grid>
          <Flex wrap="wrap" gap="2">
            {remedyRangeOptions.map((option) => {
              const href = buildRemedyRangeHref(
                option.value,
                searchQuery,
                activeTimeZone,
              );

              return (
                <Button
                  asChild
                  key={option.value}
                  size="xs"
                  variant={option.value === range ? "solid" : "outline"}
                >
                  <a aria-current={option.value === range ? "page" : undefined} href={href}>
                    {option.label}
                  </a>
                </Button>
              );
            })}
          </Flex>
        </Flex>
        {historyStatus === "loading" ? (
          <Text color="fg.muted" textStyle="sm" role="status">
            Loading timeline in {activeTimeZone}…
          </Text>
        ) : null}
        {historyStatus === "error" ? (
          <Text color="fg.error" textStyle="sm" role="alert">
            Could not load the timeline in {activeTimeZone}.
          </Text>
        ) : null}
        {visibleIntakes.length > 0 ? (
          <Grid gap="3" rounded="xl" borderWidth="1px" bg="bg.subtle" p="3" templateColumns={{ base: "minmax(0, 1fr)", lg: "minmax(0, 2fr) minmax(16rem, 1fr)" }}>
            <Grid gap="3" minW="0">
              <Flex wrap="wrap" align="center" justify="space-between" gap="2">
                <Text fontWeight="medium" textStyle="sm">
                  {visibleIntakes.length} intake{visibleIntakes.length === 1 ? "" : "s"} in range
                </Text>
                <Text color="fg.muted" textStyle="xs">
                  {timeline.bucketLabels[0]} to {timeline.bucketLabels[timeline.bucketLabels.length - 1]}
                </Text>
              </Flex>
              <Grid gap="2" overflowX="auto">
                {timeline.rows.map((row) => (
                  <Grid
                    gap="2" rounded="lg" borderWidth="1px" bg="bg" p="3"
                    minW={`${timeline.bucketLabels.length * 24 + 24}px`}
                    key={row.itemId}
                  >
                    <Flex wrap="wrap" align="center" justify="space-between" gap="2">
                      <Text fontWeight="medium" textStyle="sm">
                        {row.itemTitle}
                        {row.archived ? " · archived" : ""}
                      </Text>
                      <Text color="fg.muted" textStyle="xs">
                        {row.total} intake{row.total === 1 ? "" : "s"}
                      </Text>
                    </Flex>
                    <Grid
                      gap="1"
                      templateColumns={`repeat(${timeline.bucketLabels.length}, minmax(0, 1fr))`}
                    >
                      {row.buckets.map((bucket, index) => (
                        <Grid
                          minH="10" alignContent="start" justifyItems="center" gap="1" rounded="sm" borderWidth="1px" borderStyle="dashed" borderColor="border.muted" p="1"
                          key={`${row.itemId}:${timeline.bucketLabels[index]}`}
                        >
                          {bucket.map((intake) => (
                            <Box
                              as="span"
                              aria-label={buildIntakeTooltip(intake, activeTimeZone)}
                              display="inline-flex"
                              boxSize="2.5"
                              rounded="full"
                              bg={row.color}
                              _focusVisible={{ outline: "2px solid", outlineColor: "colorPalette.focusRing" }}
                              key={intake.id}
                              role="img"
                              tabIndex={0}
                              title={buildIntakeTooltip(intake, activeTimeZone)}
                            />
                          ))}
                        </Grid>
                      ))}
                    </Grid>
                  </Grid>
                ))}
              </Grid>
            </Grid>
            <Grid gap="2" rounded="lg" borderWidth="1px" bg="bg" p="3" minW="0">
              <Heading as="h3" size="xs" fontWeight="medium">Totals</Heading>
              <Grid as="ul" gap="2" listStyleType="none">
                {timeline.rows.map((row) => (
                  <Grid as="li" gap="1" key={`${row.itemId}:totals`}>
                    <Text fontWeight="medium" textStyle="sm">
                      {row.itemTitle}: {row.total}
                    </Text>
                    <Text color="fg.muted" textStyle="xs">
                      {row.potencyTotals.map(([potency, total]) => `${potency} ${total}`).join(" · ")}
                    </Text>
                  </Grid>
                ))}
              </Grid>
            </Grid>
          </Grid>
        ) : (
          <Text rounded="lg" borderWidth="1px" borderStyle="dashed" px="3" py="4" color="fg.muted" textStyle="sm">
            No remedy intakes in this range.
          </Text>
        )}
      </Grid>

      <Grid gap="1">
        <Heading as="h2" size="sm">Record remedy intake</Heading>
        <Text color="fg.muted" textStyle="sm">
          Logging affects health history only. Inventory quantity never changes.
        </Text>
      </Grid>

      {feedback.status !== "idle" ? (
        <Text
          textStyle="sm"
          color={feedback.status === "error" ? "fg.error" : "fg.success"}
          role="status"
        >
          {feedback.message}
        </Text>
      ) : null}

      {remedies.length === 0 ? (
        <Text rounded="lg" borderWidth="1px" borderStyle="dashed" px="3" py="4" color="fg.muted" textStyle="sm">
          No active remedies available for intake.
        </Text>
      ) : (
        <Grid
          asChild
          gap="3"
          templateColumns={{ base: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }}
        >
          <form onSubmit={submit}>
            <Field.Root>
              <Field.Label>Remedy</Field.Label>
              <FilterSelect
                label="Remedy"
                name="itemId"
                size="md"
                w="full"
                highlightActive={false}
                value={selectedRemedy?.id ?? ""}
                onChange={(nextItemId) => {
                  const nextRemedy = remedies.find((remedy) => remedy.id === nextItemId);
                  setSelectedItemId(nextItemId);
                  setSelectedPotency(nextRemedy?.remedyProfile?.potencies[0] ?? "");
                }}
                items={remedies.map((remedy) => ({ value: remedy.id, label: remedy.title }))}
              />
            </Field.Root>

            <Field.Root>
              <Field.Label>Potency</Field.Label>
              <FilterSelect
                label="Potency"
                name="potency"
                size="md"
                w="full"
                highlightActive={false}
                value={selectedPotency}
                onChange={setSelectedPotency}
                items={potencyOptions.map((potency) => ({ value: potency, label: potency }))}
              />
            </Field.Root>

            <Field.Root>
              <Field.Label>Occurred at</Field.Label>
              <Input
                name="occurredAt"
                onChange={(event) => setOccurredAt(event.currentTarget.value)}
                type="datetime-local"
                value={occurredAt}
              />
            </Field.Root>

            <Field.Root gridColumn={{ md: "span 2" }}>
              <Field.Label>Note</Field.Label>
              <Input
                name="note"
                onChange={(event) => setNote(event.currentTarget.value)}
                placeholder="Optional"
                value={note}
              />
            </Field.Root>

            <Button
              size="sm"
              disabled={isPending}
              type="submit"
            >
              Record intake
            </Button>
          </form>
        </Grid>
      )}

      <Grid gap="2">
        <Heading as="h3" size="xs" fontWeight="medium">Recent intakes</Heading>
        {intakes.length === 0 ? (
          <Text color="fg.muted" textStyle="sm">No remedy intake history yet.</Text>
        ) : (
          <Grid as="ul" gap="2" listStyleType="none">
            {intakes.map((intake) => (
              <Grid
                as="li" gap="2" rounded="lg" borderWidth="1px" p="3"
                key={intake.id}
              >
                <Flex align="start" justify="space-between" gap="3">
                  <Grid gap="1">
                    <Text fontWeight="medium" textStyle="sm">
                      {intake.itemTitle} · {intake.potency}
                    </Text>
                    <Text color="fg.muted" textStyle="sm">
                      {formatIntakeDate(intake.occurredAt, activeTimeZone)}
                      {intake.itemArchivedAt ? " · archived remedy" : ""}
                    </Text>
                    {intake.note ? <Text textStyle="sm" overflowWrap="anywhere">{intake.note}</Text> : null}
                  </Grid>
                  <Button
                    size="xs" variant="ghost" colorPalette="red"
                    disabled={isPending}
                    onClick={() => confirmDelete(intake.id)}
                    type="button"
                  >
                    Delete
                  </Button>
                </Flex>
                {confirmingDeleteId === intake.id ? (
                  <Flex align="center" wrap="wrap" gap="2">
                    <Text as="span" color="fg.muted" textStyle="sm">
                      Delete this intake?
                    </Text>
                    <Button
                      size="xs" variant="outline"
                      disabled={isPending}
                      onClick={() => removeIntake(intake.id)}
                      type="button"
                    >
                      Confirm delete
                    </Button>
                    <Button
                      size="xs" variant="outline"
                      disabled={isPending}
                      onClick={() => setConfirmingDeleteId(null)}
                      type="button"
                    >
                      Cancel
                    </Button>
                  </Flex>
                ) : null}
              </Grid>
            ))}
          </Grid>
        )}
      </Grid>
    </Grid>
  );
}

function formatDateTimeLocalValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function buildRemedyRangeHref(
  range: RemedyIntakeRange,
  searchQuery: string,
  timeZone?: string,
): string {
  const params = new URLSearchParams();

  if (searchQuery.trim()) {
    params.set("q", searchQuery.trim());
  }

  params.set("range", range);

  if (timeZone?.trim()) {
    params.set("timeZone", timeZone.trim());
  }

  return `/inventory/remedies?${params}`;
}

function filterRemedyIntakesByRange(
  intakes: RemedyTimelineIntake[],
  range: RemedyIntakeRange,
  nowIso: string,
  timeZone: string,
): RemedyTimelineIntake[] {
  if (range === "all") {
    return intakes;
  }

  const bucketKeys = new Set(buildDayBuckets(range, nowIso, timeZone));

  return intakes.filter((intake) =>
    bucketKeys.has(buildLocalDayKey(intake.occurredAt, timeZone)),
  );
}

function buildRemedyTimeline(input: {
  intakes: RemedyTimelineIntake[];
  nowIso: string;
  range: RemedyIntakeRange;
  remedies: RemedyOption[];
  timeZone: string;
}) {
  const buckets =
    input.range === "all"
      ? buildMonthBuckets(input.intakes, input.nowIso, input.timeZone)
      : buildDayBuckets(input.range, input.nowIso, input.timeZone);
  const bucketLabels = buckets.map((bucket) =>
    formatRemedyBucketLabel(bucket, input.range),
  );
  const order = new Map(input.remedies.map((remedy, index) => [remedy.id, index]));
  const rows = new Map<
    string,
    {
      archived: boolean;
      buckets: RemedyTimelineIntake[][];
      colorKey: string;
      itemId: string;
      itemTitle: string;
      potencyCounts: Map<string, number>;
      total: number;
    }
  >();

  for (const intake of input.intakes) {
    const bucketIndex = findBucketIndex(
      buckets,
      intake.occurredAt,
      input.range,
      input.timeZone,
    );

    if (bucketIndex < 0) {
      continue;
    }

    const existing = rows.get(intake.itemId) ?? {
      archived: Boolean(intake.itemArchivedAt),
      buckets: buckets.map(() => []),
      colorKey: intake.colorKey ?? remedyColorKey(intake.itemId),
      itemId: intake.itemId,
      itemTitle: intake.itemTitle,
      potencyCounts: new Map<string, number>(),
      total: 0,
    };

    existing.archived ||= Boolean(intake.itemArchivedAt);
    existing.itemTitle = intake.itemTitle;
    existing.total += 1;
    existing.buckets[bucketIndex]?.push(intake);
    existing.potencyCounts.set(
      intake.potency,
      (existing.potencyCounts.get(intake.potency) ?? 0) + 1,
    );
    rows.set(intake.itemId, existing);
  }

  return {
    bucketLabels,
    rows: [...rows.values()]
      .sort((left, right) => {
        const leftOrder = order.get(left.itemId) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = order.get(right.itemId) ?? Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        return left.itemTitle.localeCompare(right.itemTitle);
      })
      .map((row) => ({
        archived: row.archived,
        buckets: row.buckets,
        color: remedyLaneColor(row.colorKey),
        potencyTotals: [...row.potencyCounts.entries()].sort((left, right) =>
          left[0].localeCompare(right[0]),
        ),
        itemId: row.itemId,
        itemTitle: row.itemTitle,
        total: row.total,
      })),
  };
}

function buildDayBuckets(
  range: Exclude<RemedyIntakeRange, "all">,
  nowIso: string,
  timeZone: string,
): string[] {
  const length = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const end = calendarDayKeyToDate(buildLocalDayKey(nowIso, timeZone));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (length - 1));

  return Array.from({ length }, (_, index) => {
    const bucket = new Date(start);
    bucket.setUTCDate(start.getUTCDate() + index);
    return formatCalendarDayKey(bucket);
  });
}

function buildMonthBuckets(
  intakes: RemedyTimelineIntake[],
  nowIso: string,
  timeZone: string,
): string[] {
  const monthKeys = [
    buildLocalMonthKey(nowIso, timeZone),
    ...intakes.map((intake) => buildLocalMonthKey(intake.occurredAt, timeZone)),
  ].sort();
  const start = calendarMonthKeyToDate(monthKeys[0] ?? "1970-01");
  const end = calendarMonthKeyToDate(monthKeys.at(-1) ?? "1970-01");
  const buckets: string[] = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    buckets.push(formatCalendarMonthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return buckets;
}

function findBucketIndex(
  buckets: string[],
  occurredAt: string,
  range: RemedyIntakeRange,
  timeZone: string,
): number {
  if (range === "all") {
    return buckets.indexOf(buildLocalMonthKey(occurredAt, timeZone));
  }

  return buckets.indexOf(buildLocalDayKey(occurredAt, timeZone));
}

function buildIntakeTooltip(intake: RemedyTimelineIntake, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });

  return [
    intake.itemTitle,
    intake.potency,
    formatter.format(new Date(intake.occurredAt)),
    intake.note,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatIntakeDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

function remedyLaneColor(colorKey: string): string {
  const index = Number(colorKey.match(/(\d+)$/u)?.[1] ?? 0);
  return remedyLaneColors[index % remedyLaneColors.length] ?? remedyLaneColors[0];
}

function remedyColorKey(itemId: string): string {
  let hash = 2_166_136_261;

  for (const character of itemId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return `remedy-${(hash >>> 0) % remedyLaneColors.length}`;
}

function normalizeRemedyTimeZone(timeZone?: string): string {
  const candidate =
    timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

function buildLocalDayKey(value: Date | string, timeZone: string): string {
  const { day, month, year } = getTimeZoneDateParts(value, timeZone);
  return `${year}-${padCalendarPart(month)}-${padCalendarPart(day)}`;
}

function buildLocalMonthKey(value: Date | string, timeZone: string): string {
  const { month, year } = getTimeZoneDateParts(value, timeZone);
  return `${year}-${padCalendarPart(month)}`;
}

function getTimeZoneDateParts(
  value: Date | string,
  timeZone: string,
): { day: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);

  return {
    day: Number(parts.find((part) => part.type === "day")?.value ?? 1),
    month: Number(parts.find((part) => part.type === "month")?.value ?? 1),
    year: Number(parts.find((part) => part.type === "year")?.value ?? 1970),
  };
}

function padCalendarPart(value: number): string {
  return String(value).padStart(2, "0");
}

function calendarDayKeyToDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function calendarMonthKeyToDate(key: string): Date {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1));
}

function formatCalendarDayKey(value: Date): string {
  return [
    value.getUTCFullYear(),
    padCalendarPart(value.getUTCMonth() + 1),
    padCalendarPart(value.getUTCDate()),
  ].join("-");
}

function formatCalendarMonthKey(value: Date): string {
  return [value.getUTCFullYear(), padCalendarPart(value.getUTCMonth() + 1)].join(
    "-",
  );
}

function formatRemedyBucketLabel(
  bucket: string,
  range: RemedyIntakeRange,
): string {
  const formatter =
    range === "all"
      ? new Intl.DateTimeFormat("en-US", {
          month: "short",
          timeZone: "UTC",
          year: "numeric",
        })
      : new Intl.DateTimeFormat("en-US", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        });

  return formatter.format(
    range === "all"
      ? calendarMonthKeyToDate(bucket)
      : calendarDayKeyToDate(bucket),
  );
}
