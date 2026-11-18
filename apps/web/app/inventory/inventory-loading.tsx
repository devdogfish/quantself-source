import { Flex, Grid, Box, Skeleton } from "@chakra-ui/react";
import {
  AlertTriangleIcon,
  ArchiveIcon,
  PackagePlusIcon,
  SearchIcon,
  WorkflowIcon,
} from "lucide-react";

import { InventoryShellCard } from "./inventory-shell";

export function InventoryTitleMetaSkeleton() {
  return <Skeleton height="5" width="24" />;
}

export function InventoryCaptureContentSkeleton() {
  return (
    <Grid
      role="status"
      aria-busy="true"
      alignItems="start"
      gap="4"
      gridTemplateColumns={{ lg: "minmax(0,2fr) minmax(18rem,1fr)" }}
      aria-label="Loading inventory capture and search"
    >
      <InventoryShellCard
        icon={<PackagePlusIcon aria-hidden="true" />}
        title="Capture Session"
      >
        <Grid gap="4">
          <Skeleton height="11" width={{ base: "full", sm: "72" }} />
          <Grid
            gap="4"
            templateColumns={{ md: "minmax(0, 1.2fr) minmax(0, 1fr)" }}
          >
            <Grid gap="4" p="4" borderWidth="1px" rounded="xl" bg="bg.subtle">
              <Skeleton height="5" width="20" />
              <Skeleton height="16" width="full" />
              <Skeleton height="16" width="full" />
              <Skeleton height="24" width="full" />
            </Grid>
            <Grid gap="4" p="4" borderWidth="1px" rounded="xl" bg="bg.subtle">
              <Skeleton height="5" width="20" />
              <Skeleton height="14" width="full" />
              <Skeleton height="14" width="full" />
              <Skeleton height="14" width="full" />
              <Skeleton height="9" width="full" />
            </Grid>
          </Grid>
          <Skeleton
            height="10"
            width={{ base: "full", sm: "32" }}
            justifySelf="end"
          />
        </Grid>
      </InventoryShellCard>

      <InventoryShellCard
        icon={<SearchIcon aria-hidden="true" />}
        title="Search"
      >
        <Skeleton height="9" width="100%" />
      </InventoryShellCard>
    </Grid>
  );
}

export function InventoryBrowseContentSkeleton() {
  return (
    <Grid
      role="status"
      aria-busy="true"
      gap="4"
      aria-label="Loading inventory items"
    >
      <InventoryShellCard
        icon={<SearchIcon aria-hidden="true" />}
        title="Browse"
      >
        <Grid gap="3" gridTemplateColumns={{ sm: "minmax(0,1fr) auto" }}>
          <Skeleton height="9" width="100%" />
          <Flex gap="2">
            <Skeleton height="9" width="20" />
            <Skeleton height="9" width="20" />
          </Flex>
        </Grid>
        <Grid gap="2">
          <Skeleton height="6" width="full" />
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton height="16" width="full" key={index} />
          ))}
        </Grid>
      </InventoryShellCard>
      <Skeleton height="8" width="24" justifySelf="end" />
    </Grid>
  );
}

export function InventoryProcessingContentSkeleton() {
  return (
    <Grid
      role="status"
      aria-busy="true"
      gap="4"
      aria-label="Loading inventory processing board"
    >
      <Flex
        flexDirection={{ base: "column", sm: "row" }}
        gap="2"
        justifyContent={{ sm: "end" }}
      >
        <Skeleton height="9" width={{ base: "100%", sm: "80" }} />
        <Skeleton height="9" width={{ base: "100%", sm: "24" }} />
      </Flex>
      <Grid
        alignItems="start"
        gap="4"
        gridTemplateColumns={{ xl: "minmax(20rem,0.9fr) minmax(0,1.55fr)" }}
      >
        <InventoryShellCard
          icon={<AlertTriangleIcon aria-hidden="true" />}
          title="Needs review"
        >
          <Grid gap="3">
            <Skeleton height="28" width="100%" />
            <Skeleton height="28" width="100%" />
          </Grid>
        </InventoryShellCard>
        <InventoryShellCard
          icon={<WorkflowIcon aria-hidden="true" />}
          title="Pipeline"
        >
          <Grid
            gap="3"
            gridTemplateColumns={{ lg: "repeat(3, minmax(0, 1fr))" }}
          >
            {Array.from({ length: 3 }, (_, index) => (
              <Grid gap="3" key={index}>
                <Skeleton height="5" width="24" />
                <Skeleton height="28" width="100%" />
                <Skeleton height="28" width="100%" />
              </Grid>
            ))}
          </Grid>
        </InventoryShellCard>
      </Grid>
    </Grid>
  );
}

export function InventoryArchiveContentSkeleton() {
  return (
    <Box role="status" aria-busy="true" aria-label="Loading archived inventory">
      <InventoryShellCard
        description="Items kept for reference but hidden from active inventory."
        icon={<ArchiveIcon aria-hidden="true" />}
        title="Archived items"
      >
        <Skeleton height="9" width="100%" />
        <Grid
          borderColor="border"
          borderRadius="lg"
          borderWidth="1px"
          css={{ "& > * + *": { borderTopWidth: "1px" } }}
        >
          {Array.from({ length: 4 }, (_, index) => (
            <Flex alignItems="center" gap="3" p="3" key={index}>
              <Grid minWidth="0" flex="1" gap="2">
                <Skeleton height="4" width="40" maxWidth="100%" />
                <Skeleton height="3" width="64" maxWidth="100%" />
              </Grid>
              <Skeleton height="8" width="20" />
            </Flex>
          ))}
        </Grid>
      </InventoryShellCard>
    </Box>
  );
}
