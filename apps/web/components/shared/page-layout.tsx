"use client";

// Page frame: PageHeader (subtle band: title, description, actions, facts, sub-nav) + PageBody container.
import { Box, Container, DataList, Flex, Heading, Stack, Text } from "@chakra-ui/react";

export type PageFact = { label: string; value: React.ReactNode };

export function PageBody({ children, ...rest }: { children: React.ReactNode } & React.ComponentProps<typeof Container>) {
  return <Container maxW="7xl" py="6" {...rest}>{children}</Container>;
}

export function PageHeader({ title, description, actions, facts, nav }: {
  title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; facts?: PageFact[]; nav?: React.ReactNode;
}) {
  return (
    <Box borderBottomWidth="1px" bg="bg.subtle">
      <Container maxW="7xl" pt="7" pb={nav ? "0" : "5"}>
        <Flex justify="space-between" align="start" gap="4" wrap="wrap" mb={facts?.length || nav ? "5" : "0"}>
          <Stack gap="1" minW="0">
            <Heading as="h1" size="xl" fontWeight="semibold">{title}</Heading>
            {description && <Text textStyle="sm" color="fg.muted" maxW="2xl">{description}</Text>}
          </Stack>
          {actions && <Flex gap="2" align="center" flexShrink={0}>{actions}</Flex>}
        </Flex>
        {facts && facts.length > 0 && (
          <DataList.Root orientation="vertical" size="sm" display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: `repeat(${Math.min(facts.length, 4)}, minmax(0, 1fr))` }} gap="5" mb={nav ? "5" : "0"}>
            {facts.map((f) => <Fact key={f.label} label={f.label}>{f.value}</Fact>)}
          </DataList.Root>
        )}
        {nav}
      </Container>
    </Box>
  );
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue display="block" fontWeight="medium" fontVariantNumeric="tabular-nums">{children}</DataList.ItemValue>
    </DataList.Item>
  );
}
