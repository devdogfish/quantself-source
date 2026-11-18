"use client";

import { Flex, Box, Button, Input, InputGroup } from "@chakra-ui/react";

import { SearchIcon } from "lucide-react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { inventorySecondaryButton } from "./inventory-button-styles";

export const INVENTORY_SEARCH_DEBOUNCE_MS = 200;

export function InventorySearchForm({
  action = "/inventory",
  preservedParams,
  query,
}: {
  action?: string;
  preservedParams?: Record<string, string | null | undefined>;
  query: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(query);
  const [isPending, startTransition] = useTransition();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(query);

  function cancelScheduledSearch() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  function navigate(nextValue: string) {
    cancelScheduledSearch();
    const normalizedQuery = nextValue.trim();
    const params = new URLSearchParams(searchParams.toString());

    if (normalizedQuery) {
      params.set("q", normalizedQuery);
    } else {
      params.delete("q");
    }

    const nextUrl =
      `${pathname}${params.size > 0 ? `?${params}` : ""}` as Route;
    startTransition(() => {
      router.replace(nextUrl, { scroll: false });
    });
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const nextValue = event.currentTarget.value;
    valueRef.current = nextValue;
    setValue(nextValue);
    cancelScheduledSearch();
    timeoutRef.current = setTimeout(
      () => navigate(nextValue),
      INVENTORY_SEARCH_DEBOUNCE_MS,
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(valueRef.current);
  }

  useEffect(() => () => cancelScheduledSearch(), []);

  return (
    <Flex asChild flexDirection={{ base: "column", sm: "row" }} gap="2">
      <form action={action} method="get" onSubmit={handleSubmit}>
        {Object.entries(preservedParams ?? {}).map(([name, value]) =>
          value ? (
            <input key={name} name={name} type="hidden" value={value} />
          ) : null,
        )}
        <InputGroup
          startElement={<SearchIcon size={16} />}
          minWidth="0"
          flex="1"
        >
          <Input
            aria-label="Search inventory"
            autoComplete="off"
            name="q"
            onChange={handleChange}
            placeholder="Find items"
            type="search"
            value={value}
          />
        </InputGroup>
        <Button {...inventorySecondaryButton} type="submit">
          Search inventory
        </Button>
        <Box as="span" aria-live="polite" srOnly={true}>
          {isPending ? "Searching inventory" : ""}
        </Box>
      </form>
    </Flex>
  );
}
