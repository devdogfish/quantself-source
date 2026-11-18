"use client";

import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import { Chart, useChart } from "@chakra-ui/charts";
import { CartesianGrid, Line, LineChart, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

type SignalPoint = {
  date: Date;
  productivity: number;
  focus: number;
  energy: number;
  caffeineLoad: number;
  caffeineMg: number;
  foodStability: number;
  substanceLoad: number;
};

const signals = [
  { name: "productivity", label: "Productivity", color: "brand.solid" },
  { name: "focus", label: "Focus", color: "teal.solid" },
  { name: "energy", label: "Energy", color: "orange.solid" },
  { name: "caffeineLoad", label: "Caffeine", color: "purple.solid" },
  { name: "foodStability", label: "Food", color: "green.solid" },
  { name: "substanceLoad", label: "Substance", color: "gray.solid" },
] as const;

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type TooltipPayload = { dataKey?: string | number; value?: number | string; payload: { timestamp: number; caffeineMg: number } };

function SignalTooltip({ active, payload, colorOf }: { active?: boolean; payload?: TooltipPayload[]; colorOf: (token: string) => string | undefined }) {
  if (!active || !payload?.length) return null;
  return (
    <Stack gap="1.5" minW="40" p="2.5" rounded="l2" borderWidth="1px" bg="bg.panel" shadow="md" textStyle="xs">
      <Text fontWeight="medium">{formatTime(Number(payload[0]?.payload.timestamp))}</Text>
      {signals.map((signal) => {
        const entry = payload.find((item) => item.dataKey === signal.name);
        if (!entry) return null;
        return (
          <HStack key={signal.name} justify="space-between" gap="4">
            <HStack gap="2">
              <Box boxSize="2" rounded="sm" style={{ backgroundColor: colorOf(signal.color) }} />
              <Text color="fg.muted">{signal.label}</Text>
            </HStack>
            <Text fontFamily="mono" fontVariantNumeric="tabular-nums">
              {signal.name === "caffeineLoad" ? `${entry.payload.caffeineMg}mg` : entry.value}
            </Text>
          </HStack>
        );
      })}
    </Stack>
  );
}

export function ProductivitySignalChart({ data }: { data: SignalPoint[] }) {
  const rows = data.map((point) => ({ ...point, timestamp: point.date.getTime() }));
  const chart = useChart({
    data: rows,
    series: signals.map((signal) => ({ name: signal.name, color: signal.color, label: signal.label })),
  });

  return (
    <Stack gap="3">
      <HStack gap="4" wrap="wrap">
        {signals.map((signal) => (
          <HStack key={signal.name} gap="1.5" textStyle="xs">
            <Box w="3" h="0.5" rounded="full" bg={signal.color} />
            <Text color="fg.muted">{signal.label}</Text>
          </HStack>
        ))}
      </HStack>
      <Chart.Root
        chart={chart}
        h={{ base: "72", sm: "80" }}
        w="full"
        aria-label="Productivity, focus, energy, caffeine, food and substance trends"
      >
        <LineChart responsive accessibilityLayer data={chart.data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid stroke={chart.color("border.muted")} vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="timestamp"
            domain={["dataMin", "dataMax"]}
            fontSize={11}
            scale="time"
            stroke={chart.color("fg.muted")}
            tickFormatter={formatTime}
            tickLine={false}
            tickMargin={8}
            type="number"
          />
          <YAxis axisLine={false} domain={[0, 100]} fontSize={11} stroke={chart.color("fg.muted")} tickLine={false} width={28} />
          <RTooltip animationDuration={0} content={<SignalTooltip colorOf={chart.color} />} />
          {signals.map((signal) => (
            <Line
              key={signal.name}
              dataKey={signal.name}
              dot={false}
              isAnimationActive={false}
              stroke={chart.color(signal.color)}
              strokeWidth={signal.name === "productivity" ? 3 : 2}
              type="monotone"
            />
          ))}
        </LineChart>
      </Chart.Root>
    </Stack>
  );
}
