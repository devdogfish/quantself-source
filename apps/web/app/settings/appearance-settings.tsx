"use client";

// Appearance group: theme, primary colour and navigation layout, all saved in this browser.
import { useSyncExternalStore, type ElementType, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { Box, Button, Heading, HStack, RadioCard, Separator, Stack, Text } from "@chakra-ui/react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { applyBrand, DEFAULT_BRAND, savedBrand } from "@/components/chakra/brand";
import { EVENT_KINDS, EVENT_LOOKS, HABIT_LOOKS, useEventLook, useHabitLook, type EventKind, type EventLook, type HabitLook } from "@/lib/habit-look";
import { LAYOUTS, useLayoutPreference, type Layout } from "@/components/app-shell/layout-preference";

const THEMES = [
  { value: "light", label: "Light", description: "Always light", icon: SunIcon },
  { value: "dark", label: "Dark", description: "Always dark", icon: MoonIcon },
  { value: "system", label: "System", description: "Follow this device", icon: MonitorIcon },
];

const BRANDS = [
  { value: "#005daa", label: "Blue" }, { value: "#0f766e", label: "Teal" }, { value: "#6d28d9", label: "Violet" },
  { value: "#be123c", label: "Crimson" }, { value: "#c2410c", label: "Orange" }, { value: "#334155", label: "Slate" },
];

const brandListeners = new Set<() => void>();
const subscribeBrand = (listener: () => void) => {
  brandListeners.add(listener);
  return () => void brandListeners.delete(listener);
};
const subscribeNever = () => () => {};

export function AppearanceSettings() {
  const { layout, setLayout } = useLayoutPreference();
  const { theme, setTheme } = useTheme();
  const { look, setLook } = useHabitLook();
  // Saved values are only known in the browser; the server render and hydration use the defaults.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const brand = useSyncExternalStore(subscribeBrand, savedBrand, () => DEFAULT_BRAND);
  const chooseBrand = (hex: string) => {
    applyBrand(hex);
    brandListeners.forEach((listener) => listener());
  };

  return (
    <Box as="section" aria-labelledby="appearance-heading" minW="0">
      <Heading as="h2" id="appearance-heading" size="lg" fontWeight="semibold">Appearance</Heading>
      <Separator mt="4" />
      <Row title="Theme" help="Saved in this browser.">
        <Choices label="Theme" value={mounted ? theme ?? "system" : undefined} onChange={setTheme} items={THEMES} />
      </Row>
      <Separator />
      <Row title="Primary colour" help="Buttons, switches, links and focus rings. Saved in this browser.">
        <HStack gap="3" wrap="wrap">
          {BRANDS.map((b) => (
            <Box key={b.value} as="button" aria-label={b.label} title={b.label} aria-pressed={brand.toLowerCase() === b.value}
              onClick={() => chooseBrand(b.value)} boxSize="8" rounded="full" bg={b.value} borderWidth="2px" borderColor="bg"
              outlineWidth="2px" outlineStyle="solid" outlineColor={brand.toLowerCase() === b.value ? "fg" : "transparent"} cursor="pointer" />
          ))}
          <input type="color" aria-label="Custom colour" value={brand} onChange={(e) => chooseBrand(e.target.value)}
            style={{ width: 32, height: 32, padding: 0, border: 0, background: "none", cursor: "pointer" }} />
          <Text textStyle="sm" color="fg.muted" fontFamily="mono" data-testid="brand-hex">{brand.toUpperCase()}</Text>
          {brand.toLowerCase() !== DEFAULT_BRAND && <Button size="xs" variant="ghost" onClick={() => chooseBrand(DEFAULT_BRAND)}>Reset</Button>}
        </HStack>
      </Row>
      <Separator />
      <Row title="Navigation layout" help="Saved in this browser.">
        <Choices label="Navigation layout" value={layout} onChange={(v) => setLayout(v as Layout)} items={LAYOUTS} />
      </Row>
      <Separator />
      <Row title="Habit style" help="How habits look on the Calendar. Saved in this browser.">
        <Choices label="Habit style" value={mounted ? look : undefined} onChange={(v) => setLook(v as HabitLook)} items={[...HABIT_LOOKS]} />
      </Row>
      <Separator />
      {EVENT_KINDS.map(({ kind, title, help }) => (
        <EventLookRow key={kind} kind={kind} title={title} help={help} mounted={mounted} />
      ))}
    </Box>
  );
}

function EventLookRow({ kind, title, help, mounted }: { kind: EventKind; title: string; help: string; mounted: boolean }) {
  const { look, setLook } = useEventLook(kind);
  return (
    <>
      <Row title={`${title} style`} help={`${help} Saved in this browser.`}>
        <Choices label={`${title} style`} value={mounted ? look : undefined} onChange={(v) => setLook(v as EventLook)} items={[...EVENT_LOOKS]} />
      </Row>
      <Separator />
    </>
  );
}

function Row({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <Stack direction={{ base: "column", md: "row" }} gap={{ base: "4", md: "10" }} py="6">
      <Box w={{ md: "64" }} flexShrink={0}>
        <Text textStyle="sm" fontWeight="medium">{title}</Text>
        <Text textStyle="sm" color="fg.muted" mt="1">{help}</Text>
      </Box>
      <Box flex="1" maxW="3xl">{children}</Box>
    </Stack>
  );
}

function Choices({ label, value, onChange, items }: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  items: { value: string; label: string; description: string; icon?: ElementType }[];
}) {
  return (
    <RadioCard.Root size="sm" aria-label={label} value={value ?? null} onValueChange={(e) => e.value && onChange(e.value)}>
      <Stack direction={{ base: "column", sm: "row" }} gap="3">
        {items.map((it) => (
          <RadioCard.Item key={it.value} value={it.value} flex="1">
            <RadioCard.ItemHiddenInput />
            <RadioCard.ItemControl>
              <RadioCard.ItemContent>
                {it.icon && <Box color="fg.muted" mb="1"><it.icon size={16} aria-hidden="true" /></Box>}
                <RadioCard.ItemText>{it.label}</RadioCard.ItemText>
                <RadioCard.ItemDescription>{it.description}</RadioCard.ItemDescription>
              </RadioCard.ItemContent>
              <RadioCard.ItemIndicator />
            </RadioCard.ItemControl>
          </RadioCard.Item>
        ))}
      </Stack>
    </RadioCard.Root>
  );
}
