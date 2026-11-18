"use client";

import { Box, HStack, IconButton, Menu, Portal } from "@chakra-ui/react";

import { ChevronDownIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

export const inventorySpecialistBrowseRoutes = [
  { href: "/inventory/clothing", label: "Clothing" },
  { href: "/inventory/remedies", label: "Remedies" },
  { href: "/inventory/supplements", label: "Supplements" },
  { href: "/inventory/food", label: "Food" },
] as const satisfies ReadonlyArray<{ href: Route; label: string }>;

export function InventoryBrowseNav({
  active,
  menuOnly = false,
}: {
  active: boolean;
  menuOnly?: boolean;
}) {
  return (
    <HStack
      gap="0"
      flexShrink={0}
      borderBottomWidth="2px"
      borderColor={active ? "colorPalette.solid" : "transparent"}
    >
      {!menuOnly && (
        <Box
          asChild
          px="3"
          py="2.5"
          textStyle="sm"
          fontWeight={active ? "semibold" : "medium"}
          color={active ? "fg" : "fg.muted"}
          _hover={{ color: "fg" }}
        >
          <Link
            aria-current={active ? "page" : undefined}
            href="/inventory/browse"
          >
            Browse
          </Link>
        </Box>
      )}
      <Menu.Root positioning={{ placement: "bottom-end" }}>
        <Menu.Trigger asChild>
          <IconButton aria-label="Open Browse pages" size="xs" variant="ghost">
            <ChevronDownIcon />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="40">
              {inventorySpecialistBrowseRoutes.map((route) => (
                <Menu.Item asChild key={route.href} value={route.href}>
                  <Link href={route.href}>{route.label}</Link>
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </HStack>
  );
}
