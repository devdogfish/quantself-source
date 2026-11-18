import { Box, Badge, Card, Flex, Grid, Link, Text } from "@chakra-ui/react";

import type { InventoryRemedyProfile } from "@/lib/quantself-api-client";

export function InventoryRemedyProfileCard({
  remedyProfile,
}: {
  remedyProfile: NonNullable<InventoryRemedyProfile>;
}) {
  return (
    <Card.Root
      size="sm"
      borderRadius="0.875rem"
      overflow="hidden"
      gap="4"
      py="4"
    >
      <Card.Header px="4" py="0">
        <Card.Title as="h2" fontSize="md" fontWeight="medium" lineHeight="snug">
          Remedy profile
        </Card.Title>
      </Card.Header>
      <Card.Body
        px="4"
        py="0"
        flex="initial"
        display="grid"
        gap="4"
        fontSize="sm"
      >
        <Flex flexWrap="wrap" gap="2">
          {remedyProfile.potencies.map((potency) => (
            <Badge
              borderRadius="full"
              size="sm"
              flexShrink={0}
              w="fit-content"
              key={potency}
              variant="subtle"
              colorPalette="gray"
            >
              {potency}
            </Badge>
          ))}
        </Flex>

        <Grid gap="2">
          <Text fontWeight="medium">Selection summary</Text>
          <Text color="fg.muted">
            {remedyProfile.selectionSummary ?? "No local summary yet."}
          </Text>
        </Grid>

        <Grid gap="2">
          <Text fontWeight="medium">External references</Text>
          {remedyProfile.externalReferences.length > 0 ? (
            <Box as="ul" display="grid" gap="2" color="fg.muted">
              {remedyProfile.externalReferences.map((reference) => (
                <li key={`${reference.source}:${reference.url}`}>
                  <Box as="span" fontWeight="medium" color="fg">
                    {reference.source}
                  </Box>
                  {reference.referenceId ? ` (${reference.referenceId})` : ""}
                  {" · "}
                  <Link
                    textDecoration="underline"
                    textUnderlineOffset="4px"
                    href={reference.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {reference.url}
                  </Link>
                </li>
              ))}
            </Box>
          ) : (
            <Text color="fg.muted">No external references stored.</Text>
          )}
        </Grid>
      </Card.Body>
    </Card.Root>
  );
}
