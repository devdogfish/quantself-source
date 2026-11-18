"use client";

// Chart building blocks on @chakra-ui/charts: Donut, SegBar, Sparkline, AreaTrend, MultiTrend, BarRows.
import { useState } from "react";
import Link from "next/link";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { Chart, useChart } from "@chakra-ui/charts";
import { Area, AreaChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Tooltip } from "@/components/chakra/tooltip";
import { asRoute, formatInt, type Part, type Point, type TrendSeries } from "./dashboard-types";

// A donut with its legend: name, value, share. Hovering a slice or row highlights both; rows link when a part has `to`.
export function Donut({ parts, center, centerLabel, size = 140, legend = "side", format = formatInt }: {
  parts: Part[]; center?: React.ReactNode; centerLabel?: string; size?: number; legend?: "side" | "below"; format?: (n: number) => string;
}) {
  const data = parts.filter((p) => p.value > 0);
  const chart = useChart({ data });
  const total = data.reduce((t, p) => t + p.value, 0);
  const [active, setActive] = useState<string | null>(null);
  const activePart = data.find((d) => d.name === active) ?? null;
  return (
    <Flex direction={legend === "side" ? { base: "column", sm: "row" } : "column"} align={legend === "side" ? { base: "start", sm: "center" } : "stretch"} gap="5">
      <Box position="relative" w={`${size}px`} h={`${size}px`} flexShrink={0} alignSelf={legend === "below" ? "center" : undefined}>
        <Chart.Root chart={chart} w={`${size}px`} h={`${size}px`}>
          <PieChart responsive>
            <Pie isAnimationActive={false} data={chart.data} dataKey={chart.key("value")} nameKey="name"
              onMouseEnter={(_: unknown, i: number) => setActive(data[i]?.name ?? null)} onMouseLeave={() => setActive(null)}
              innerRadius={size * 0.36} outerRadius={size / 2 - 2} stroke={chart.color("bg")} strokeWidth={2} startAngle={90} endAngle={-270}>
              {chart.data.map((d) => <Cell key={d.name} fill={chart.color(d.color)} fillOpacity={active && active !== d.name ? 0.55 : 1} style={{ transition: "fill-opacity .2s ease", outline: "none" }} />)}
            </Pie>
          </PieChart>
        </Chart.Root>
        {center != null && (
          <Stack position="absolute" inset="0" align="center" justify="center" gap="0" pointerEvents="none">
            <Text textStyle="lg" fontWeight="semibold" lineHeight="1" fontVariantNumeric="tabular-nums">{activePart ? `${Math.round((activePart.value / total) * 100)}%` : center}</Text>
            {(activePart || centerLabel) && <Text textStyle="2xs" color="fg.muted" mt="0.5" maxW="70%" textAlign="center" truncate>{activePart ? activePart.name : centerLabel}</Text>}
          </Stack>
        )}
      </Box>
      <Stack gap="1" flex="1" minW="0" w="full">
        {parts.map((p) => {
          const row = (
            <HStack gap="2" textStyle="xs" py="0.5" fontVariantNumeric="tabular-nums" w="full" transition="opacity .2s ease" opacity={active && active !== p.name ? 0.6 : 1}>
              <Box boxSize="2.5" rounded="sm" bg={p.color} flexShrink={0} />
              <Text flex="1" truncate title={p.hint}>{p.name}</Text>
              <Text color="fg.muted">{format(p.value)}</Text>
              <Text w="9" textAlign="right" fontWeight="medium">{total ? Math.round((p.value / total) * 100) : 0}%</Text>
            </HStack>
          );
          const hover = { onMouseEnter: () => setActive(p.name), onMouseLeave: () => setActive(null) };
          return p.to
            ? <Box asChild key={p.name} rounded="l1" px="1" mx="-1" bg={active === p.name ? "bg.muted" : undefined} {...hover}><Link href={asRoute(p.to)}>{row}</Link></Box>
            : <Box key={p.name} rounded="l1" px="1" mx="-1" bg={active === p.name ? "bg.muted" : undefined} {...hover}>{row}</Box>;
        })}
      </Stack>
    </Flex>
  );
}

// One whole split into parts, as a single bar with 2px gaps; each part has a tooltip and can link
export function SegBar({ parts, h = "3", format = formatInt }: { parts: Part[]; h?: string; format?: (n: number) => string }) {
  const total = parts.reduce((t, p) => t + p.value, 0) || 1;
  return (
    <Flex h={h} gap="2px" rounded="full" overflow="hidden" w="full">
      {parts.filter((p) => p.value > 0).map((p) => {
        const seg = <Box h="full" bg={p.color} flexGrow={p.value} flexBasis="0" minW="1" _hover={{ opacity: 0.8 }} />;
        return (
          <Tooltip key={p.name} content={`${p.name}: ${format(p.value)} (${Math.round((p.value / total) * 100)}%)`} openDelay={50} closeDelay={0}>
            {p.to ? <Box asChild flexGrow={p.value} flexBasis="0" minW="1" display="block"><Link href={asRoute(p.to)} aria-label={p.name}>{seg}</Link></Box> : seg}
          </Tooltip>
        );
      })}
    </Flex>
  );
}

// Tiny line with no axes; the last point is marked
export function Sparkline({ values, color = "fg.muted", h = "8", w = "full", pad = 0 }: { values: number[]; color?: string; h?: string; w?: string; pad?: number }) {
  const data = values.map((v, i) => ({ i, v }));
  const chart = useChart({ data, series: [{ name: "v", color }] });
  return (
    <Chart.Root chart={chart} h={h} w={w}>
      <LineChart responsive data={chart.data} margin={{ top: 3, right: 4, bottom: 3, left: 4 }}>
        <YAxis hide domain={pad ? [(m: number) => m - pad, (m: number) => m + pad] : ["dataMin", "dataMax"]} />
        <Line isAnimationActive={false} type="monotone" dataKey="v" stroke={chart.color(color)} strokeWidth={1.5}
          dot={(p: { cx?: number; cy?: number; index?: number }) => p.index === data.length - 1
            ? <circle key={p.index} cx={p.cx} cy={p.cy} r={2.5} fill={chart.color(color)} />
            : <g key={p.index} />} />
      </LineChart>
    </Chart.Root>
  );
}

const axis = (chart: { color: (c: string) => string | undefined }) =>
  ({ tickLine: false, axisLine: false, fontSize: 11, stroke: chart.color("fg.muted") }) as const;

// One series as a filled area with a padded y domain
export function AreaTrend({ points, valueKey = "value", label = "Value", color = "brand.solid", h = "56", format, domain }: {
  points: Point[]; valueKey?: string; label?: string; color?: string; h?: string; format?: (n: number) => string; domain?: [number, number];
}) {
  const data = points.map((p) => ({ label: p.label, [valueKey]: p.values[valueKey] }));
  const chart = useChart({ data, series: [{ name: valueKey, color, label }] });
  const ys = points.map((p) => p.values[valueKey]);
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.1 || 1;
  const gradient = `fill-${valueKey}`;
  return (
    <Chart.Root chart={chart} h={h}>
      <AreaChart responsive data={chart.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <Chart.Gradient id={gradient} stops={[{ offset: "0%", color, opacity: 0.25 }, { offset: "100%", color, opacity: 0.02 }]} />
        </defs>
        <CartesianGrid stroke={chart.color("border.muted")} vertical={false} />
        <XAxis dataKey="label" {...axis(chart)} interval="preserveStartEnd" minTickGap={32} />
        <YAxis domain={domain ?? [Math.min(...ys) - pad, Math.max(...ys) + pad]} width={36} {...axis(chart)} tickFormatter={format ? (v) => format(Number(v)) : undefined} />
        <RTooltip animationDuration={0} content={<Chart.Tooltip formatter={format ? (v) => format(Number(v)) : undefined} />} />
        <Area isAnimationActive={false} type="monotone" dataKey={chart.key(valueKey)} stroke={chart.color(color)} strokeWidth={2} fill={`url(#${gradient})`}
          activeDot={{ r: 4, stroke: chart.color("bg"), strokeWidth: 2 }} />
      </AreaChart>
    </Chart.Root>
  );
}

// Several series on one axis (lines, or stacked areas); a legend sits above
export function MultiTrend({ points, series, h = "56", stacked = false, domain, format = formatInt }: {
  points: Point[]; series: TrendSeries[]; h?: string; stacked?: boolean; domain?: [number, number]; format?: (n: number) => string;
}) {
  const data = points.map((p) => ({ label: p.label, ...p.values }));
  const chart = useChart<Record<string, string | number>>({ data, series: series.map((s) => ({ name: s.key, color: s.color, label: s.label })) });
  const margin = { top: 4, right: 8, left: 0, bottom: 0 };
  const common = (
    <>
      <CartesianGrid stroke={chart.color("border.muted")} vertical={false} />
      <XAxis dataKey="label" {...axis(chart)} interval="preserveStartEnd" minTickGap={32} />
      <YAxis width={44} domain={domain ?? ["auto", "auto"]} {...axis(chart)} tickFormatter={(v) => format(Number(v))} />
      <RTooltip animationDuration={0} content={<Chart.Tooltip formatter={(v) => format(Number(v))} />} />
    </>
  );
  return (
    <Stack gap="2">
      <HStack gap="4" wrap="wrap">
        {series.map((s) => (
          <HStack key={s.key} gap="1.5" textStyle="xs"><Box w="3" h="0.5" rounded="full" bg={s.color} /><Text color="fg.muted">{s.label}</Text></HStack>
        ))}
      </HStack>
      <Chart.Root chart={chart} h={h}>
        {stacked ? (
          <AreaChart responsive data={chart.data} margin={margin}>
            {common}
            {chart.series.map((s) => (
              <Area key={String(s.name)} isAnimationActive={false} type="monotone" stackId="a" dataKey={String(s.name)}
                stroke={chart.color("bg")} strokeWidth={1.5} fill={chart.color(s.color)} fillOpacity={0.85} />
            ))}
          </AreaChart>
        ) : (
          <LineChart responsive data={chart.data} margin={margin}>
            {common}
            {chart.series.map((s) => (
              <Line key={String(s.name)} isAnimationActive={false} type="monotone" dataKey={String(s.name)} stroke={chart.color(s.color)} strokeWidth={2} dot={false}
                activeDot={{ r: 4, stroke: chart.color("bg"), strokeWidth: 2 }} />
            ))}
          </LineChart>
        )}
      </Chart.Root>
    </Stack>
  );
}

// Horizontal bars for a ranked list, each row optionally linking somewhere
export function BarRows({ rows, color = "brand.solid", format = formatInt }: {
  rows: { label: React.ReactNode; value: number; display?: React.ReactNode; href?: string; right?: React.ReactNode; color?: string }[];
  color?: string; format?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Stack gap="1">
      {rows.map((r, k) => {
        const body = (
          <Box position="relative" py="1.5" px="2" rounded="l1">
            <Box position="absolute" insetY="0.5" left="0" w={`${Math.max(1, (r.value / max) * 100)}%`} bg={r.color ?? color} opacity={0.14} rounded="l1" />
            <HStack position="relative" gap="3" textStyle="sm" fontVariantNumeric="tabular-nums">
              <Box flex="1" minW="0" truncate>{r.label}</Box>
              {r.right}
              <Box fontWeight="medium" minW="12" textAlign="right">{r.display ?? format(r.value)}</Box>
            </HStack>
          </Box>
        );
        return r.href
          ? <Box asChild key={k} display="block" rounded="l1" _hover={{ bg: "bg.muted" }}><Link href={asRoute(r.href)}>{body}</Link></Box>
          : <Box key={k}>{body}</Box>;
      })}
    </Stack>
  );
}
