"use client";
import { Heading, Stack, Text } from "@chakra-ui/react";
import { HabitWorkspace } from "./habit-workspace";
import { HabitDocuments } from "./habit-documents";

export function HabitSystem() {
  return (
    <HabitWorkspace>
      <Stack gap="2">
        <Heading as="h2" fontSize="xl" fontWeight="semibold">
          Your habit system
        </Heading>
        <Text fontSize="sm" color="fg.muted">
          Review your system, playbook, and past reviews.
        </Text>
      </Stack>
      <HabitDocuments />
    </HabitWorkspace>
  );
}
