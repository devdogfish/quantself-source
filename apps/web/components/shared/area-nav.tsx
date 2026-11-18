"use client";

// Tabs-as-links for an area with sub-pages (line style); current page via pathname, scrolls sideways on mobile.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, HStack } from "@chakra-ui/react";
import { asRoute } from "./dashboard-types";

export type AreaNavItem = { href: string; label: string; exact?: boolean; also?: string[] };

export function AreaNav({ items, label = "Sections", currentPath }: { items: AreaNavItem[]; label?: string; currentPath?: string }) {
  const routePath = usePathname();
  const pathname = currentPath ?? routePath ?? "";
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  // `also`: other path prefixes that belong to this tab (e.g. receipt detail pages under Documents).
  const isCurrent = (i: AreaNavItem) => pathname === i.href || (!i.exact && pathname.startsWith(`${i.href}/`)) || !!i.also?.some(under);
  return (
    <Box as="nav" aria-label={label} overflowX="auto" mx="-1" px="1" css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}>
      <HStack gap="1" minW="max-content">
        {items.map((i) => {
          const current = isCurrent(i);
          return (
            <Box asChild key={i.href} px="3" py="2.5" textStyle="sm" whiteSpace="nowrap"
              fontWeight={current ? "semibold" : "medium"} color={current ? "fg" : "fg.muted"}
              borderBottomWidth="2px" borderColor={current ? "colorPalette.solid" : "transparent"} mb="-1px"
              _hover={{ color: "fg" }}>
              <Link href={asRoute(i.href)} aria-current={current ? "page" : undefined}>{i.label}</Link>
            </Box>
          );
        })}
      </HStack>
    </Box>
  );
}
