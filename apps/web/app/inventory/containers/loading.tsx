import { Box, Flex, Grid, Skeleton } from "@chakra-ui/react";
import { LoadingRegion } from "@/components/loading-region";
import { containerPage, listHeader } from "./container-layout";

export default function InventoryContainersLoading() {
  return (
    <Box {...containerPage}>
      <LoadingRegion label="Loading containers">
        <Flex as="header" {...listHeader}>
          <Skeleton
            boxSize="10"
            borderRadius="l2"
          />
          <Flex
            order={1}
            minW="0"
            flex="1"
            justify="center"
            css={{ "@media (min-width: 40rem)": { order: 0 } }}
          >
            <Flex w="full" maxW="31rem" minW="0" align="center" gap="2">
              <Skeleton h="10" minW="0" flex="1" borderRadius="l2" />
              <Skeleton boxSize="10" flexShrink={0} borderRadius="l2" />
            </Flex>
          </Flex>
          <Skeleton h="10" w="20" flexShrink={0} borderRadius="l2" />
        </Flex>
        <Grid
          as="section"
          minH="100svh"
          placeItems="center"
          px="5"
          pt="24"
          pb="8"
        >
          <Grid w="full" maxW="5xl" placeItems="center" gap="5">
            <Skeleton h="4" w="40" />
            <Skeleton
              h="min(58svh, 34rem)"
              w="full"
              maxW="3xl"
              borderRadius="2rem"
            />
          </Grid>
        </Grid>
      </LoadingRegion>
    </Box>
  );
}
