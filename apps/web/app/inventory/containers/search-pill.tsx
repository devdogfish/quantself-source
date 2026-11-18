"use client";

import { Input, InputGroup, type InputProps } from "@chakra-ui/react";
import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SearchPill({
  end,
  endOffset,
  ...input
}: InputProps & { end?: ReactNode; endOffset?: string }) {
  return (
    <InputGroup
      minW="0"
      startElement={<SearchIcon size={16} aria-hidden="true" />}
      endElement={end}
      endOffset={endOffset}
      endElementProps={{ pointerEvents: "none" }}
    >
      <Input
        size="md"
        minW="0"
        bg="bg"
        fontSize={{ base: "md", md: "sm" }}
        {...input}
      />
    </InputGroup>
  );
}
