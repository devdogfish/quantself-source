"use client";

import { Box, VisuallyHidden } from "@chakra-ui/react";
import type { ComponentProps } from "react";

export function LoadingRegion({
  children,
  label = "Loading content",
  ...props
}: ComponentProps<"div"> & { label?: string }) {
  return (
    <Box aria-busy="true" aria-live="polite" {...props}>
      <VisuallyHidden>{label}</VisuallyHidden>
      {children}
    </Box>
  );
}
