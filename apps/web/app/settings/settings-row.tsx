"use client";

import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import { useId, type ReactNode } from "react";

export function SettingsRow({
  title,
  help,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Stack
      as="section"
      aria-labelledby={headingId}
      direction={{ base: "column", md: "row" }}
      gap={{ base: "4", md: "10" }}
      py="6"
      borderBottomWidth="1px"
      minW="0"
    >
      <Box w={{ md: "64" }} flexShrink={0}>
        <Heading as="h2" id={headingId} size="sm" fontWeight="medium">
          {title}
        </Heading>
        {help && (
          <Text textStyle="sm" color="fg.muted" mt="1">
            {help}
          </Text>
        )}
      </Box>
      <Box flex="1" minW="0" maxW="3xl">
        {children}
      </Box>
    </Stack>
  );
}
