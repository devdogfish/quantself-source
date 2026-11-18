"use client";

import { Field, NativeSelect } from "@chakra-ui/react";

export function InventoryItemSelectField({
  defaultValue,
  id,
  label,
  name,
  onValueChange,
  options,
  value,
}: {
  defaultValue?: string;
  id: string;
  label: string;
  name: string;
  onValueChange?: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value?: string;
}) {
  return (
    <Field.Root gap="2">
      <Field.Label htmlFor={id}>{label}</Field.Label>
      <NativeSelect.Root size="sm">
        <NativeSelect.Field
          defaultValue={defaultValue}
          id={id}
          name={name}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
          value={value}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}
