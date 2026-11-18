"use client";

import { Button, Grid, Text, type TextProps } from "@chakra-ui/react";
import { useId, useState } from "react";

const COLLAPSE_THRESHOLD = 240;

export function InventoryItemCollapsibleText({
  label = "extracted evidence",
  text,
  ...textProps
}: TextProps & {
  label?: string;
  text: string;
}) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);

  if (text.length <= COLLAPSE_THRESHOLD) {
    return <Text {...textProps}>{text}</Text>;
  }

  return (
    <Grid gap="1.5">
      <Text {...textProps} lineClamp={expanded ? undefined : 3} id={contentId}>
        {text}
      </Text>
      <Button
        aria-controls={contentId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Read less" : "Read more"} ${label}`}
        justifySelf="start"
        variant="plain"
        size="xs"
        minW="0"
        h="auto"
        p="0"
        textUnderlineOffset="4px"
        _hover={{ textDecoration: "underline" }}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        {expanded ? "Read less" : "Read more"}
      </Button>
    </Grid>
  );
}
