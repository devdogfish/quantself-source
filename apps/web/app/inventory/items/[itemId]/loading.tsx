import { Box, Grid, Skeleton } from "@chakra-ui/react";
import { LoadingRegion } from "@/components/loading-region";

import { InventoryShellLayout } from "../../inventory-shell";

export default function InventoryItemLoading() {
  return (
    <InventoryShellLayout
      active="item"
      title="Item details"
      titleMeta={<Skeleton h="5" w="24" />}
    >
      <LoadingRegion label="Loading item details">
        <Grid gap="4">
          <Skeleton h="9" w="24" />
          <Box
            as="section"
            display="grid"
            gap="4"
            css={{
              "@media (width >= 80rem)": {
                gridTemplateColumns: "minmax(0, 1.15fr) minmax(19rem, .85fr)",
              },
            }}
          >
            <Grid gap="4">
              <Skeleton h="64" w="full" borderRadius="0.875rem" />
              <Skeleton h="44" w="full" borderRadius="0.875rem" />
            </Grid>
            <Box as="aside" display="grid" alignContent="start" gap="4">
              <Skeleton h="52" w="full" borderRadius="0.875rem" />
              <Skeleton h="40" w="full" borderRadius="0.875rem" />
            </Box>
          </Box>
        </Grid>
      </LoadingRegion>
    </InventoryShellLayout>
  );
}
