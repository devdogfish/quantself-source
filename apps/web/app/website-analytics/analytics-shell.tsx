"use client";

// Frame shared by the Website and Job search pages: page header with area tabs and facts, a filter bar that rolls
// into the app top bar once scrolled past (ScrollSwapBar), table cards, URL-backed filters, report loading, and the
// "can I trust this?" tracking line.
import { useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, Button, Flex, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { ListFilter } from "lucide-react";
import { AreaNav } from "@/components/shared/area-nav";
import { Help } from "@/components/shared/dashboard";
import { PageBody, PageHeader, type PageFact } from "@/components/shared/page-layout";
import { ScrollSwapBar } from "@/components/app-shell/top-bar-slot";
import type { TrackingStatus } from "./contract";

export function AnalyticsShell({ facts, children }: { facts?: PageFact[]; children: React.ReactNode }) {
  return <Box as="main" minW="0" pb="16">
    <PageHeader title="Website analytics" facts={facts} nav={<AreaNav label="Analytics views" items={[
      { href: "/website-analytics", label: "Website", exact: true },
      { href: "/website-analytics/job-search", label: "Job search" },
    ]} />} />
    <PageBody><Stack gap="5" minW="0">{children}</Stack></PageBody>
  </Box>;
}

// Filters live in the URL (shareable, reload-stable). A filter at its default value is left out of the URL.
export function useUrlFilters<K extends string>(defaults: Record<K, string>, notCounted: NoInfer<K>[] = []) {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const values = Object.fromEntries((Object.keys(defaults) as K[]).map((k) => [k, params.get(k) ?? defaults[k]])) as Record<K, string>;
  const set = (patch: Partial<Record<K, string>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch) as [K, string][]) {
      if (v === defaults[k]) next.delete(k); else next.set(k, v);
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ""}` as Route, { scroll: false });
  };
  const counted = (Object.keys(defaults) as K[]).filter((k) => !notCounted.includes(k));
  const active = counted.filter((k) => values[k] !== defaults[k]).length;
  const clear = () => set(Object.fromEntries(counted.map((k) => [k, defaults[k]])) as Partial<Record<K, string>>);
  return { values, set, active, clear };
}

// Filters on the left, date range on the right. Rendered inline and, once scrolled past, in the app top bar.
export function FilterBar({ children, range, active, onClear }: { children: React.ReactNode; range: React.ReactNode; active: number; onClear: () => void }) {
  return <ScrollSwapBar>
    <Flex justify="space-between" align="center" gap="2" wrap="wrap" minH="9">
      <HStack gap="2" wrap="wrap">
        <Icon as={ListFilter} boxSize="4" color="fg.muted" aria-hidden />
        {children}
        {active > 0 && <Button size="xs" variant="ghost" onClick={onClear}>{active > 1 ? `Clear ${active} filters` : "Clear filter"}</Button>}
      </HStack>
      {range}
    </Flex>
  </ScrollSwapBar>;
}

// Bordered card whose body runs edge to edge (tables): header bar with title, optional help tooltip and an action.
export function TableCard({ title, help, action, children }: { title: string; help?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <Box as="section" aria-label={title} borderWidth="1px" rounded="l2" overflow="hidden" bg="bg" minW="0">
    <HStack justify="space-between" gap="3" px="5" h="12" borderBottomWidth="1px">
      <HStack gap="1.5"><Text as="h2" textStyle="sm" fontWeight="semibold">{title}</Text>{help && <Help text={help} />}</HStack>
      {action}
    </HStack>
    {children}
  </Box>;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string, now: number) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 48 ? relative.format(hours, "hour") : relative.format(Math.round(hours / 24), "day");
}

export function TrackingLine({ status }: { status: TrackingStatus }) {
  const now = Date.parse(status.generatedAt);
  const stale = !status.lastEventAt || now - Date.parse(status.lastEventAt) > 3 * 86_400_000;
  return <HStack gap="5" textStyle="xs" color="fg.muted" wrap="wrap">
    <HStack gap="1.5"><Box boxSize="1.5" rounded="full" bg={stale ? "orange.solid" : "green.solid"} />
      {status.lastEventAt ? `Last event ${ago(status.lastEventAt, now)}` : "No events received yet"}</HStack>
    <HStack gap="1.5">{status.excludedScanners} scanner opens excluded
      <Help text="Opens tagged as link scanners (for example within seconds of sending, no script execution) are left out of every number. They stay visible in each application's visits." /></HStack>
  </HStack>;
}

// GET a report. Keeps showing the previous report while a new filter combination loads.
export function useReport<T>(path: string) {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: "", loading: true });
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const mine = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: "" }));
    fetch(path, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) throw Error(body?.message ?? (response.status === 404 ? "The analytics API is not available yet." : `Analytics request failed (${response.status}).`));
      return body as T;
    }).then(
      (data) => { if (mine === generation.current) setState({ data, error: "", loading: false }); },
      (cause) => { if (!controller.signal.aborted && mine === generation.current) setState((s) => ({ ...s, error: cause instanceof Error ? cause.message : "Analytics request failed.", loading: false })); },
    );
    return () => controller.abort();
  }, [path, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

export function ReportState({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  if (error) return <Box borderWidth="1px" rounded="l2" p="5" role="alert">
    <Text textStyle="sm" fontWeight="medium">Couldn’t load analytics</Text>
    <Text textStyle="sm" color="fg.muted" mt="1">{error}</Text>
    <Button size="sm" variant="outline" mt="3" onClick={retry}>Try again</Button>
  </Box>;
  if (loading) return <Box borderWidth="1px" rounded="l2" p="5" role="status"><Text textStyle="sm" color="fg.muted">Loading analytics…</Text></Box>;
  return null;
}
