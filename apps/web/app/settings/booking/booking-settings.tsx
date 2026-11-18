"use client";
import { useEffect, useMemo, useState } from "react";
import createClient from "openapi-fetch";
import { Box, Button, Checkbox, HStack, IconButton, NumberInput, Skeleton, Stack, Text } from "@chakra-ui/react";
import { PlusIcon, XIcon } from "lucide-react";
import type { components, paths } from "@/lib/generated/quantself-api-schema";
import { FilterSelect, type Item } from "@/components/shared/filter-select";
import { toaster } from "@/components/chakra/toaster";
import { SettingsRow } from "../settings-row";

type Range = [string, string];
type Weekday = (typeof weekdays)[number][0];
/** The API returns ranges as string[][]; they are always [start, end] pairs. */
export type BookingSettingsValue = Omit<components["schemas"]["MeetingSettings"], "weeklyHours"> & { weeklyHours: Partial<Record<Weekday, Range[]>> };
const weekdays = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]] as const;

const client = createClient<paths>({
  baseUrl: typeof window === "undefined" ? "" : window.location.origin,
  credentials: "same-origin",
  fetch: request => globalThis.fetch(request),
});

const clocks = Array.from({ length: 49 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
const clockItems = (values: string[]): Item[] => values.map(value => ({ value, label: value }));
const noticeItems: Item[] = [
  { value: "0", label: "None" }, { value: "60", label: "1 hour" }, { value: "120", label: "2 hours" }, { value: "240", label: "4 hours" },
  { value: "720", label: "12 hours" }, { value: "1440", label: "1 day" }, { value: "2880", label: "2 days" }, { value: "10080", label: "1 week" },
];
const minutesLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} days` : minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;

/** Next free half-hour range after a day's last range. */
function nextRange(ranges: Range[]): Range | null {
  const last = ranges.at(-1)?.[1] ?? "08:30";
  const start = clocks.indexOf(last) + 1;
  return start + 2 < clocks.length ? [clocks[start]!, clocks[Math.min(start + 8, clocks.length - 1)]!] : null;
}

export function BookingSettings() {
  const [saved, setSaved] = useState<BookingSettingsValue>();
  const [draft, setDraft] = useState<BookingSettingsValue>();
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return clockItems(draft && !zones.includes(draft.timeZone) ? [draft.timeZone, ...zones] : zones);
  }, [draft]);

  useEffect(() => {
    const controller = new AbortController();
    void client.GET("/api/v1/meetings/settings", { signal: controller.signal, cache: "no-store" }).then(({ data, error }) => {
      if (data) { setSaved(data as BookingSettingsValue); setDraft(data as BookingSettingsValue); } else setLoadError(error?.message ?? "Booking settings unavailable.");
    }).catch(() => { if (!controller.signal.aborted) setLoadError("Booking settings unavailable."); });
    return () => controller.abort();
  }, []);

  if (loadError) return <Text role="alert" color="fg.error" py="6">{loadError}</Text>;
  if (!draft || !saved) return <Stack py="6" gap="3" role="status" aria-label="Loading booking settings">{weekdays.map(([day]) => <Skeleton key={day} h="8" />)}</Stack>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const setDay = (day: Weekday, ranges: Range[]) => {
    const weeklyHours = { ...draft.weeklyHours };
    if (ranges.length) weeklyHours[day] = ranges; else delete weeklyHours[day];
    setDraft({ ...draft, weeklyHours });
  };
  const invalidDays = weekdays.filter(([day]) => {
    const ranges = draft.weeklyHours[day] ?? [];
    return ranges.some(([start, end], index) => start >= end || (index > 0 && start < ranges[index - 1]![1]));
  }).map(([, label]) => label);

  async function save() {
    const value = draft!;
    setSaving(true);
    try {
      const { data, error } = await client.PUT("/api/v1/meetings/settings", { body: value });
      if (!data) throw new Error(error?.message ?? "Could not save booking settings.");
      setSaved(data as BookingSettingsValue);
      // Keep edits made while the save was in flight.
      setDraft(current => JSON.stringify(current) === JSON.stringify(value) ? data as BookingSettingsValue : current);
    } catch (error) {
      toaster.create({ type: "error", title: "Booking settings not saved", description: error instanceof Error ? error.message : undefined, duration: Infinity });
    } finally {
      setSaving(false);
    }
  }

  return <Stack gap="0">
    <SettingsRow title="Weekly hours" help="Visitors can book 30-minute calls inside these hours. Timed tasks and existing meetings still block slots.">
      <Stack gap="3">
        {weekdays.map(([day, label]) => {
          const ranges = draft.weeklyHours[day] ?? [];
          const add = nextRange(ranges);
          return <HStack key={day} align="start" gap="4" minH="8">
            <Checkbox.Root w="32" pt="1.5" flexShrink={0} checked={ranges.length > 0}
              onCheckedChange={({ checked }) => setDay(day, checked ? [["09:00", "17:00"]] : [])}>
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label>{label}</Checkbox.Label>
            </Checkbox.Root>
            {ranges.length === 0 ? <Text pt="1.5" textStyle="sm" color="fg.muted">Unavailable</Text> : <Stack gap="2">
              {ranges.map(([start, end], index) => <HStack key={index} gap="2">
                <FilterSelect size="sm" w="24" highlightActive={false} label={`${label} start ${index + 1}`} value={start}
                  items={clockItems(clocks.slice(0, -1))} onChange={value => setDay(day, ranges.map((range, i) => i === index ? [value, range[1]] : range))} />
                <Text color="fg.muted">–</Text>
                <FilterSelect size="sm" w="24" highlightActive={false} label={`${label} end ${index + 1}`} value={end}
                  items={clockItems(clocks.slice(1))} onChange={value => setDay(day, ranges.map((range, i) => i === index ? [range[0], value] : range))} />
                <IconButton size="sm" variant="ghost" aria-label={`Remove ${label} range ${index + 1}`} onClick={() => setDay(day, ranges.filter((_, i) => i !== index))}><XIcon /></IconButton>
                {index === ranges.length - 1 && add && ranges.length < 6 && <IconButton size="sm" variant="ghost" aria-label={`Add ${label} range`} onClick={() => setDay(day, [...ranges, add])}><PlusIcon /></IconButton>}
              </HStack>)}
            </Stack>}
          </HStack>;
        })}
        {invalidDays.length > 0 && <Text role="alert" textStyle="sm" color="fg.error">Fix overlapping or reversed hours on {invalidDays.join(", ")}.</Text>}
      </Stack>
    </SettingsRow>
    <SettingsRow title="Time zone" help="Weekly hours are in this time zone.">
      <FilterSelect size="sm" w="72" highlightActive={false} label="Time zone" value={draft.timeZone} items={timeZones}
        onChange={timeZone => setDraft({ ...draft, timeZone })} />
    </SettingsRow>
    <SettingsRow title="Minimum notice" help="How soon a visitor can book.">
      <FilterSelect size="sm" w="40" highlightActive={false} label="Minimum notice" value={String(draft.noticeMinutes)}
        items={noticeItems.some(item => item.value === String(draft.noticeMinutes)) ? noticeItems : [...noticeItems, { value: String(draft.noticeMinutes), label: minutesLabel(draft.noticeMinutes) }]}
        onChange={value => setDraft({ ...draft, noticeMinutes: Number(value) })} />
    </SettingsRow>
    <SettingsRow title="Booking horizon" help="How far ahead visitors can book, in days.">
      <NumberInput.Root size="sm" w="32" min={1} max={90} value={String(draft.horizonDays)}
        onValueChange={({ valueAsNumber }) => { if (Number.isInteger(valueAsNumber)) setDraft({ ...draft, horizonDays: Math.min(90, Math.max(1, valueAsNumber)) }); }}>
        <NumberInput.Control />
        <NumberInput.Input aria-label="Booking horizon in days" />
      </NumberInput.Root>
    </SettingsRow>
    <Box py="6">
      <HStack gap="3">
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty || invalidDays.length > 0}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(saved)} disabled={!dirty || saving}>Discard changes</Button>
      </HStack>
    </Box>
  </Stack>;
}
