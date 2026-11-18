"use client";

import { Button, Grid, Text } from "@chakra-ui/react";

export function SpecialistInventoryError({
  category,
  reset,
}: {
  category: "Food" | "Remedies" | "Supplements";
  reset: () => void;
}) {
  return (
    <Grid
      as="section"
      aria-label={`${category} inventory error`}
      gap="3"
      rounded="xl"
      borderWidth="1px"
      borderStyle="dashed"
      bg="bg.subtle"
      px="4"
      py="10"
      textStyle="sm"
    >
      <Text role="alert" fontWeight="medium">
        Couldn&apos;t load {category.toLowerCase()} inventory.
      </Text>
      <Button justifySelf="start" onClick={reset} type="button" variant="outline">
        Retry
      </Button>
    </Grid>
  );
}
