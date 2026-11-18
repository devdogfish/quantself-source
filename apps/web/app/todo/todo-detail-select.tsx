"use client";

import { Portal, Select } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { useItems, type Item } from "@/components/shared/filter-select";
import { useNestedOverlayRegistration } from "@/components/shared/nested-overlay-guard";

export function TodoDetailSelect({ id, label, value, items, disabled, compact, onChange }: {
  id: string;
  label: string;
  value: string;
  items: Item[];
  disabled: boolean;
  compact?: boolean;
  onChange(value: string): void;
}) {
  const collection = useItems(items);
  const [open, setOpen] = useState(false);
  const visibleOpen = open && !disabled;
  useNestedOverlayRegistration(visibleOpen);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return (
    <Select.Root
      collection={collection}
      ids={{ trigger: id }}
      value={[value]}
      open={visibleOpen}
      disabled={disabled}
      size="xs"
      w={compact ? "full" : "fit-content"}
      positioning={{ sameWidth: false, placement: "bottom-start", strategy: "fixed" }}
      lazyMount
      unmountOnExit
      onOpenChange={({ open }) => setOpen(open && !disabled)}
      onValueChange={({ value: [next] }) => {
        if (!disabled && next !== undefined) onChange(next);
      }}
    >
      <Select.Control>
        <Select.Trigger
          aria-label={label}
          data-slot="select-trigger"
          minH={compact ? "30px" : "8"}
          borderColor="border"
          pe="8"
          color="fg"
        >
          <Select.ValueText />
        </Select.Trigger>
        <Select.IndicatorGroup><Select.Indicator /></Select.IndicatorGroup>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content minW="36" bg="bg.panel" color="fg">
            {collection.items.map(item => (
              <Select.Item key={item.value} item={item}>
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}
