"use client";

import { Box, Grid } from "@chakra-ui/react";
import { useMemo } from "react";
import {
  ContainerVisual,
  type ContainerDebugRevealState,
} from "./container-visual";
import { filterContainerItems } from "./filter-items";
import type { ContainerShelf } from "./types";

export type BentoViewProps = {
  containers: ContainerShelf[];
  debugBounds?: boolean;
  debugRevealState?: ContainerDebugRevealState;
  layoutSeed?: string;
  query: string;
};

export function BentoView({
  containers,
  debugBounds = false,
  debugRevealState = "auto",
  layoutSeed = "container-scene",
  query,
}: BentoViewProps) {
  const visibleItemsByContainer = useMemo(
    () => filterContainerItems(containers, query),
    [containers, query],
  );

  if (containers.length === 0) {
    return (
      <Grid
        minH="60svh"
        placeItems="center"
        px="6"
        textAlign="center"
        color="black/60"
        textStyle="sm"
      >
        No containers in the inventory yet.
      </Grid>
    );
  }

  return (
    <Box as="section" aria-label="Bento container view" minH="100svh" pt="24">
      <Grid
        mx="auto"
        maxW="1600px"
        templateColumns="minmax(0, 1fr)"
        alignItems="start"
        gap="3"
        px="3"
        pb="24"
        css={{
          "@media (min-width: 40rem)": {
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            px: "6",
          },
          "@media (min-width: 64rem)": { gap: "4", px: "10" },
          "@media (min-width: 80rem)": {
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          },
        }}
        data-testid="bento-grid"
      >
        {containers.map((container, index) => {
          const visibleItems = visibleItemsByContainer.get(container.id) ?? [];

          return (
            <Box
              as="article"
              aria-label={`${container.name}, ${visibleItems.length} visible ${
                visibleItems.length === 1 ? "item" : "items"
              }`}
              position="relative"
              minH="0"
              minW="0"
              w="full"
              aspectRatio={1.23}
              pb={{ base: "12", lg: "16" }}
              data-container-id={container.id}
              key={container.id}
              style={{
                containIntrinsicSize: "auto 480px",
                contentVisibility: "auto",
              }}
            >
              <ContainerVisual
                container={container}
                debugBounds={debugBounds}
                debugRevealState={debugRevealState}
                layoutSeed={layoutSeed}
                mode="bento"
                priority={index < 3}
                visibleItems={visibleItems}
              />
            </Box>
          );
        })}
      </Grid>
    </Box>
  );
}
