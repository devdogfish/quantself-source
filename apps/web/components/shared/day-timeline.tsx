"use client";

// Compact one-day timeline (Sunsama-style calendar rail). Generic: pass blocks with HH:MM bounds.
// Used by the To-Do Plan view; reusable anywhere a small "what's on today" schedule helps.
import { Box, HStack, Stack, Text } from "@chakra-ui/react";

export type TimelineBlock = { key: string; start: string; end: string; title: string; palette?: string; onClick?: () => void };

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export function DayTimeline({ blocks, startHour = 8, endHour = 18, hourHeight = 44, now, title = "Today", empty = "Nothing scheduled." }: {
  blocks: TimelineBlock[]; startHour?: number; endHour?: number; hourHeight?: number; now?: string; title?: string; empty?: string;
}) {
  const first = Math.min(startHour, ...blocks.map((b) => Math.floor(minutes(b.start) / 60)));
  const last = Math.max(endHour, ...blocks.map((b) => Math.ceil(minutes(b.end) / 60)));
  const y = (hhmm: string) => ((minutes(hhmm) - first * 60) / 60) * hourHeight;
  const nowY = now ? y(now) : null;
  return (
    <Stack gap="2" aria-label={`${title} schedule`} role="region">
      <HStack justify="space-between"><Text textStyle="sm" fontWeight="semibold">{title}</Text>{blocks.length === 0 && <Text textStyle="xs" color="fg.muted">{empty}</Text>}</HStack>
      <Box position="relative" h={`${(last - first) * hourHeight}px`} borderWidth="1px" rounded="l2" bg="bg" overflow="hidden">
        {Array.from({ length: last - first }, (_, i) => (
          <HStack key={i} position="absolute" top={`${i * hourHeight}px`} left="0" right="0" h={`${hourHeight}px`} align="start" borderTopWidth={i ? "1px" : 0} borderColor="border.muted">
            <Text textStyle="2xs" color="fg.subtle" w="10" textAlign="right" pe="2" pt="0.5" fontVariantNumeric="tabular-nums">{String(first + i).padStart(2, "0")}:00</Text>
          </HStack>
        ))}
        {blocks.map((b) => {
          const palette = b.palette ?? "brand";
          return (
            <Box key={b.key} as={b.onClick ? "button" : "div"} onClick={b.onClick} textAlign="left" cursor={b.onClick ? "pointer" : undefined}
              position="absolute" left="11" right="2" top={`${y(b.start) + 1}px`} h={`${Math.max(y(b.end) - y(b.start) - 2, 18)}px`}
              rounded="sm" px="2" py="0.5" overflow="hidden" bg={`${palette}.subtle`} borderLeftWidth="3px" borderColor={`${palette}.solid`}>
              <Text textStyle="xs" fontWeight="medium" truncate>{b.title}</Text>
            </Box>
          );
        })}
        {nowY !== null && nowY >= 0 && (
          <Box position="absolute" left="10" right="0" top={`${nowY}px`} h="0" borderTopWidth="2px" borderColor="red.500" aria-label={`Now, ${now}`}>
            <Box position="absolute" left="-1" top="-1.5" boxSize="2.5" rounded="full" bg="red.500" />
          </Box>
        )}
      </Box>
    </Stack>
  );
}
