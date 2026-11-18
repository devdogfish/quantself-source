"use client";

// Dashboard frames and numbers: Panel, SectionHeading, Help, MoreLink, Delta, Stat, ProgressDial.
import Link from "next/link";
import { Box, Flex, HStack, Heading, Icon, Stack, Text, type BoxProps } from "@chakra-ui/react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Info } from "lucide-react";
import { Tooltip } from "@/components/chakra/tooltip";
import { asRoute, cssVar, formatInt } from "./dashboard-types";

export function Panel({ title, description, action, children, ...rest }: { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode } & Omit<BoxProps, "title">) {
  return (
    <Box borderWidth="1px" rounded="l3" bg="bg" p={{ base: "4", md: "5" }} minW="0" {...rest}>
      {(title || action) && (
        <Flex justify="space-between" align="start" gap="3" mb="4">
          <Stack gap="0.5" minW="0">
            {title && <Box textStyle="sm" fontWeight="semibold">{title}</Box>}
            {description && <Box textStyle="xs" color="fg.muted">{description}</Box>}
          </Stack>
          {action}
        </Flex>
      )}
      {children}
    </Box>
  );
}

export function SectionHeading({ title, description, action, id }: { title: string; description?: React.ReactNode; action?: React.ReactNode; id?: string }) {
  return (
    <Flex id={id} justify="space-between" align={{ base: "start", sm: "end" }} direction={{ base: "column", sm: "row" }} gap="2" mb="4" scrollMarginTop="20">
      <Stack gap="1">
        <Heading size="md" fontWeight="semibold">{title}</Heading>
        {description && <Text textStyle="sm" color="fg.muted" maxW="2xl">{description}</Text>}
      </Stack>
      {action}
    </Flex>
  );
}

export function Help({ text }: { text: string }) {
  return (
    <Tooltip content={text} showArrow contentProps={{ maxW: "xs" }}>
      <Box as="span" role="img" aria-label="Help" display="inline-flex" color="fg.subtle" cursor="help" verticalAlign="middle"><Icon as={Info} boxSize="3.5" /></Box>
    </Tooltip>
  );
}

export function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <HStack asChild gap="1" textStyle="xs" fontWeight="medium" color="fg.muted" _hover={{ color: "fg" }} flexShrink={0}>
      <Link href={asRoute(href)}>{children}<Icon as={ArrowRight} boxSize="3" /></Link>
    </HStack>
  );
}

// Change between two values. goodWhen says which direction is an improvement (green).
export function Delta({ now, then, goodWhen, suffix = "", fmt = formatInt, label }: {
  now: number; then: number; goodWhen: "up" | "down"; suffix?: string; fmt?: (x: number) => string; label?: string;
}) {
  const d = now - then;
  const flat = Math.abs(d) < 0.5;
  const good = flat ? null : (d > 0) === (goodWhen === "up");
  return (
    <HStack gap="1" textStyle="xs" color={good == null ? "fg.muted" : good ? "green.fg" : "red.fg"} fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
      <Icon as={flat ? ArrowRight : d > 0 ? ArrowUpRight : ArrowDownRight} boxSize="3.5" />
      <Text>{flat ? "No change" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}${suffix}`}</Text>
      {label && <Text color="fg.muted">{label}</Text>}
    </HStack>
  );
}

export function Stat({ label, value, help, children, href }: { label: string; value: React.ReactNode; help?: string; children?: React.ReactNode; href?: string }) {
  const body = (
    <Stack gap="1.5" minW="0">
      <HStack gap="1.5"><Text textStyle="xs" color="fg.muted" truncate>{label}</Text>{help && <Help text={help} />}</HStack>
      <Text textStyle="2xl" fontWeight="semibold" lineHeight="1" fontVariantNumeric="tabular-nums">{value}</Text>
      {children}
    </Stack>
  );
  return href ? <Box asChild display="block" _hover={{ "& p:nth-of-type(2)": { textDecoration: "underline" } }}><Link href={asRoute(href)}>{body}</Link></Box> : body;
}

// A meter against `max`, drawn as a ring; `caption` sits under the number on large dials.
export function ProgressDial({ value, max = 100, color = "brand.solid", size = 132, thickness = 10, label, caption }: {
  value: number; max?: number; color?: string; size?: number; thickness?: number; label: string; caption?: string;
}) {
  const r = (size - thickness) / 2, c = 2 * Math.PI * r;
  const share = Math.min(1, Math.max(0, value / max));
  return (
    <Box position="relative" w={`${size}px`} h={`${size}px`} flexShrink={0} role="img" aria-label={`${label}: ${value} out of ${max}${caption ? `, ${caption}` : ""}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={cssVar("border.muted")} strokeWidth={thickness} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={cssVar(color)} strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${share * c} ${c}`} />
      </svg>
      <Stack position="absolute" inset="0" align="center" justify="center" gap="0">
        <Text fontSize={size > 100 ? "3xl" : "lg"} fontWeight="semibold" lineHeight="1" fontVariantNumeric="tabular-nums">{value}</Text>
        {size > 100 && caption && <Text textStyle="xs" color="fg.muted" mt="1">{caption}</Text>}
      </Stack>
    </Box>
  );
}
