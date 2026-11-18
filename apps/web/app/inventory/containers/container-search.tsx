"use client";

import { Box, Text, VisuallyHidden, chakra } from "@chakra-ui/react";
import { ChevronDownIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { controlSurface } from "./container-layout";
import { SearchPill } from "./search-pill";
import type { ContainerShelf } from "./types";

type ContainerSearchProps = {
  activeId?: string;
  containers: ContainerShelf[];
  mode?: "containers";
  onSelect: (container: ContainerShelf) => void;
};

export function ContainerSearch({
  activeId,
  containers,
  mode = "containers",
  onSelect,
}: ContainerSearchProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

    if (terms.length === 0) {
      return containers;
    }

    return containers.filter((container) => {
      const searchable =
        `${container.name} ${container.referenceId} ${container.location}`.toLocaleLowerCase();

      return terms.every((term) => searchable.includes(term));
    });
  }, [containers, query]);

  const activeContainer = containers.find(
    (container) => container.id === activeId,
  );
  const safeHighlightedIndex =
    highlightedIndex >= 0 && highlightedIndex < matches.length
      ? highlightedIndex
      : -1;
  const activeOptionId =
    open && safeHighlightedIndex >= 0
      ? optionId(listboxId, safeHighlightedIndex)
      : undefined;

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setHighlightedIndex(-1);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  useEffect(() => {
    if (!activeOptionId) {
      return;
    }

    document
      .getElementById(activeOptionId)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  function choose(container: ContainerShelf) {
    setQuery("");
    setOpen(false);
    setHighlightedIndex(-1);
    onSelect(container);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setHighlightedIndex(-1);
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      if (matches.length === 0) {
        setOpen(true);
        setHighlightedIndex(-1);
        return;
      }

      const direction = event.key === "ArrowDown" ? 1 : -1;
      setOpen(true);
      setHighlightedIndex((current) => {
        if (!open || current < 0 || current >= matches.length) {
          return direction === 1 ? 0 : matches.length - 1;
        }

        return (current + direction + matches.length) % matches.length;
      });
      return;
    }

    if (event.key === "Enter" && open && safeHighlightedIndex >= 0) {
      event.preventDefault();
      choose(matches[safeHighlightedIndex]);
    }
  }

  return (
    <Box position="relative" w="full" maxW="md" asChild>
      <div data-mode={mode} ref={rootRef}>
        <SearchPill
          end={<ChevronDownIcon size={16} aria-hidden="true" />}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="Jump to a container"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setHighlightedIndex((current) =>
              current >= 0 && current < matches.length ? current : -1,
            );
          }}
          onKeyDown={handleKeyDown}
          placeholder={activeContainer?.name ?? "Find a container…"}
          role="combobox"
          type="search"
          value={query}
        />

        {open ? (
          <Box
            position="absolute"
            insetX="0"
            top="calc(100% + 0.5rem)"
            zIndex={50}
            maxH="72"
            overflowY="auto"
            {...controlSurface}
            p="1.5"
            boxShadow="md"
            id={listboxId}
            role="listbox"
          >
            {matches.length > 0 ? (
              matches.map((container, index) => (
                <chakra.button
                  aria-selected={container.id === activeId}
                  display="flex"
                  w="full"
                  alignItems="center"
                  justifyContent="space-between"
                  gap="4"
                  borderRadius="l1"
                  px="3"
                  py="2.5"
                  textAlign="left"
                  textStyle="sm"
                  outline="none"
                  bg={
                    index === safeHighlightedIndex ? "bg.emphasized" : undefined
                  }
                  color="fg"
                  _hover={{ bg: "bg.muted" }}
                  id={optionId(listboxId, index)}
                  key={container.id}
                  onClick={() => choose(container)}
                  onPointerMove={() => setHighlightedIndex(index)}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  <Box as="span" minW="0">
                    <Box as="span" display="block" truncate fontWeight="medium">
                      {container.name}
                    </Box>
                    <Box
                      as="span"
                      display="block"
                      truncate
                      textStyle="xs"
                      color="fg.muted"
                    >
                      {container.referenceId} · {container.location}
                    </Box>
                  </Box>
                  <Box as="span" flexShrink={0} textStyle="xs" color="fg.muted">
                    {container.itemCount}{" "}
                    <VisuallyHidden>
                      {container.itemCount === 1 ? "item" : "items"}
                    </VisuallyHidden>
                  </Box>
                </chakra.button>
              ))
            ) : (
              <Text
                px="3"
                py="5"
                textAlign="center"
                color="fg.muted"
                textStyle="sm"
                role="status"
              >
                No containers found
              </Text>
            )}
          </Box>
        ) : null}
      </div>
    </Box>
  );
}

function optionId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}
