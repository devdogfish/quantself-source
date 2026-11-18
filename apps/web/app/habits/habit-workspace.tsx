"use client";

import type { ReactNode } from "react";
import {
  Badge,
  Box,
  Flex,
  Stack,
  Text,
} from "@chakra-ui/react";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { AreaNav } from "@/components/shared/area-nav";

import { habitNavItems as navItems } from "./views/habits-nav";

const previewMode = process.env.NEXT_PUBLIC_QUANTSELF_HABITS_PREVIEW_MODE;

export function HabitWorkspace({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Box pb="16">
      <PageHeader
        title="Habits"
        actions={
          <Flex gap="2" align="center" wrap="wrap">
            {previewMode === "snapshot" && (
              <Text textStyle="xs" color="fg.muted">
                Your data · snapshot{" "}
                {new Intl.DateTimeFormat("en-CA", {
                  timeZone: "America/Halifax",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                }).format(
                  new Date(
                    process.env.NEXT_PUBLIC_QUANTSELF_HABITS_SNAPSHOT_AT!,
                  ),
                )}{" "}
                · read-only
              </Text>
            )}
            {previewMode === "live" && (
              <Badge variant="outline">Production · read-only</Badge>
            )}
            {previewMode === "live-write" && (
              <Badge variant="outline">Live · saves to Quantself</Badge>
            )}
            {previewMode === "sample" && (
              <Badge variant="outline">Sample data</Badge>
            )}
          </Flex>
        }
        nav={
          <Flex justify="space-between" align="center" gap="3" wrap="wrap">
            <AreaNav
              label="Habit sections"
              items={navItems}
              currentPath="/habits/system"
            />
            {actions && (
              <Box pb="2" textStyle="sm" color="fg.muted">
                {actions}
              </Box>
            )}
          </Flex>
        }
      />
      <PageBody as="main" maxW="5xl">
        <Stack gap="5">{children}</Stack>
      </PageBody>
    </Box>
  );
}
