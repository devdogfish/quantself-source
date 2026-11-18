"use client";

import { Field, Input } from "@chakra-ui/react";

import type { ReactNode } from "react";

type InventorySearchFieldProps = {
  className?: string;
  id: string;
  label: ReactNode;
  labelClassName?: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  value: string;
};

export function InventorySearchField({
  className,
  id,
  label,
  labelClassName,
  onValueChange,
  placeholder,
  value,
}: InventorySearchFieldProps) {
  return (
    <Field.Root className={className} minW="0" flex="1 1 18rem">
      <Field.Label
        className={labelClassName}
        srOnly={labelClassName === "sr-only"}
        htmlFor={id}
      >
        {label}
      </Field.Label>
      <Input
        id={id}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </Field.Root>
  );
}
