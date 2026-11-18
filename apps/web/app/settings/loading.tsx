import { Box, Skeleton, Stack } from "@chakra-ui/react";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { LoadingRegion } from "@/components/loading-region";

export default function SettingsLoading({
  contentOnly = false,
}: { contentOnly?: boolean } = {}) {
  const content = (
    <LoadingRegion
      label="Loading settings data"
      aria-label="Loading settings data"
    >
      <Stack gap="0">
        {Array.from({ length: 5 }, (_, index) => (
          <Stack
            key={index}
            direction={{ base: "column", md: "row" }}
            gap={{ base: "4", md: "10" }}
            py="6"
            borderBottomWidth="1px"
          >
            <Stack w={{ md: "64" }} flexShrink={0} gap="2">
              <Skeleton height="5" width="40" />
              <Skeleton height="4" width="56" />
            </Stack>
            <Box flex="1" minW="0" maxW="3xl">
              <Skeleton height={index === 2 ? "72" : "32"} />
            </Box>
          </Stack>
        ))}
      </Stack>
    </LoadingRegion>
  );
  if (contentOnly) return content;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Inventory Enrichment"
        facts={[
          {
            label: "Inventory proposals",
            value: <Skeleton height="4" width="16" />,
          },
        ]}
      />
      <PageBody>{content}</PageBody>
    </>
  );
}
