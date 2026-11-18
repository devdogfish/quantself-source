"use client";

// Calendar category filter (Chakra Select): All, Uncategorized, each category with its colour dot, then "Manage categories".
// The surrounding top bar collapses it to the tag icon via the `category-label` / `category-chevron` classes.
import { useMemo } from "react";
import { Box, HStack, Portal, Select, Text, createListCollection } from "@chakra-ui/react";
import { TagsIcon } from "lucide-react";
import { categoryColors, type Category } from "./todo-categories";

const MANAGE = "__manage";
type Entry = { value: string; label: string; color?: string; disabled?: boolean };

function Dot({ color }: { color: string }) {
  return <Box aria-hidden="true" boxSize="2.5" rounded="full" flexShrink={0} style={{ background: color }} />;
}

export function CategoryFilter({ value, categories, writable, onChange, onManage }: {
  value: string;
  categories: Category[];
  writable: boolean;
  onChange: (value: string) => void;
  onManage: () => void;
}) {
  const entries = useMemo<Entry[]>(() => [
    { value: "__all", label: "All categories" },
    { value: "__none", label: "Uncategorized", color: categoryColors.gray },
    ...categories.map((c) => ({ value: String(c.id), label: c.name, color: categoryColors[c.color] })),
    { value: MANAGE, label: "Manage categories", disabled: !writable },
  ], [categories, writable]);
  const collection = useMemo(() => createListCollection({ items: entries }), [entries]);
  return (
    <Select.Root size="sm" w="40" collection={collection} value={[value]} positioning={{ sameWidth: false, placement: "bottom-start" }}
      onValueChange={(e) => { const next = e.value[0]; if (next === MANAGE) onManage(); else if (next !== undefined) onChange(next); }}>
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger aria-label="Filter by category" title="Filter by category" gap="2">
          <TagsIcon size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          <Box className="category-label" flex="1" minW="0" textAlign="start"><Select.ValueText truncate /></Box>
        </Select.Trigger>
        <Select.IndicatorGroup className="category-chevron"><Select.Indicator /></Select.IndicatorGroup>
      </Select.Control>
      <Portal>
        <Select.Positioner zIndex={1500}>
          <Select.Content minW="56" maxH="80">
            {entries.map((item) => (
              <Box key={item.value}>
                {item.value === MANAGE && <Box role="separator" h="1px" bg="border" my="1" mx="-1" />}
                <Select.Item item={item}>
                  <HStack gap="2" minW="0">{item.color && <Dot color={item.color} />}<Text truncate>{item.label}</Text></HStack>
                  <Select.ItemIndicator />
                </Select.Item>
              </Box>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}
