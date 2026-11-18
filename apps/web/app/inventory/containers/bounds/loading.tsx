import { Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";
import { LoadingRegion } from "@/components/loading-region";
import { BoundsFrame } from "./bounds-frame";

export default function ContainerBoundsLoading({
  contentOnly = false,
}: {
  contentOnly?: boolean;
} = {}) {
  const content = (
    <LoadingRegion label="Loading container bounds">
      <Grid gap="4">
        <Flex
          wrap="wrap"
          align="end"
          justify="space-between"
          gap="4"
          p="4"
          borderWidth="1px"
          borderColor="border"
          borderRadius="l3"
          bg="bg.subtle"
        >
          <Flex wrap="wrap" gap="4">
            <Stack gap="1.5">
              <Skeleton h="5" w="24" />
              <Skeleton h="9" w="28" />
            </Stack>
            <Stack gap="1.5">
              <Skeleton h="5" w="16" />
              <Skeleton h="9" w="44" />
            </Stack>
          </Flex>
          <Skeleton h="9" w="40" marginInlineStart="auto" />
        </Flex>
        <Skeleton w="full" aspectRatio={1.7} borderRadius="xl" />
      </Grid>
    </LoadingRegion>
  );

  return contentOnly ? content : <BoundsFrame>{content}</BoundsFrame>;
}
