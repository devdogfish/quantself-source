"use client";

import { Box, HStack } from "@chakra-ui/react";
import type { ComponentProps } from "react";

export function Toolbar({ children, ...props }: ComponentProps<"div">) {
  return (
    <Box
      data-slot="toolbar"
      w="full"
      borderBottomWidth="1px"
      bg="bg.subtle"
      overflowX="auto"
      {...props}
    >
      <HStack role="toolbar" w="max-content" minW="full" gap="1" p="2">
        {children}
      </HStack>
    </Box>
  );
}
