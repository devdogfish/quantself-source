"use client";

// Small styled dropdown (Chakra Select). Used for table filter rows (xs, default) and forms (sm/md). The first item is the
// "no filter" value; when another value is picked the trigger gets a stronger border (and data-active) so active filters
// stand out. Forms pass `highlightActive={false}`. Pass `name` to post the value with a surrounding <form> (HiddenSelect).
import { useMemo, useState } from "react";
import { Portal, Select, Stack, Text, createListCollection } from "@chakra-ui/react";

export type Item = { value: string; label: string; hint?: string; mono?: boolean; disabled?: boolean };

// Items are usually rebuilt on every render; keep the collection stable while their content is the same
export function useItems(items: Item[]) {
  const key = JSON.stringify(items);
  return useMemo(() => createListCollection({ items: JSON.parse(key) as Item[] }), [key]);
}

type FilterSelectProps = {
  value?: string;
  defaultValue?: string;
  onChange?: (v: string) => void;
  items: Item[];
  w?: string;
  /** aria-label for the trigger (no visible label) */
  label?: string;
  /** visible label rendered above the trigger (Select.Label) */
  fieldLabel?: string;
  size?: "xs" | "sm" | "md";
  name?: string;
  disabled?: boolean;
  required?: boolean;
  highlightActive?: boolean;
  /** Menu stacking; the default sits above Chakra dialogs. */
  zIndex?: number;
  id?: string;
};

export function FilterSelect({
  value,
  defaultValue,
  onChange,
  items,
  w,
  label,
  fieldLabel,
  size = "xs",
  name,
  disabled,
  required,
  highlightActive = true,
  zIndex = 1500,
  id,
}: FilterSelectProps) {
  const collection = useItems(items);
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const current = value ?? uncontrolled;
  const on = highlightActive && current !== undefined && current !== items[0]?.value; // the first item is the "no filter" value
  return (
    <Select.Root
      collection={collection}
      ids={id ? { trigger: id } : undefined}
      size={size}
      w={w}
      value={current !== undefined ? [current] : []}
      name={name}
      disabled={disabled}
      required={required}
      onValueChange={(e) => {
        const next = e.value[0];
        if (next === undefined) return;
        if (value === undefined) setUncontrolled(next);
        onChange?.(next);
      }}
      positioning={{ sameWidth: false }}
    >
      {fieldLabel && <Select.Label>{fieldLabel}</Select.Label>}
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger aria-label={label} data-active={on ? "" : undefined} borderColor={on ? "border.emphasized" : undefined} bg={on ? "bg" : undefined} fontWeight={on ? "medium" : undefined}>
          <Select.ValueText />
        </Select.Trigger>
        <Select.IndicatorGroup><Select.Indicator /></Select.IndicatorGroup>
      </Select.Control>
      <Portal>
        <Select.Positioner zIndex={zIndex}>
          <Select.Content minW="56" maxH="80">
            {items.map((item) => (
              <Select.Item key={item.value} item={item}>
                <Stack gap="0" minW="0">
                  <Text>{item.label}</Text>
                  {item.hint && <Text textStyle="xs" color="fg.muted" fontFamily={item.mono || item.hint.startsWith("/") ? "mono" : undefined} truncate>{item.hint}</Text>}
                </Stack>
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}
