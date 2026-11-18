"use client";

import { chakra, Textarea, Tabs, Skeleton } from "@chakra-ui/react";

import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const VisualEditor = dynamic(() => import("./budget-note-visual-editor"), {
  ssr: false,
  loading: () => (
    <Skeleton h="72" width="full" aria-label="Loading Budget Note editor" />
  ),
});

export function BudgetNoteEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Tabs.Root defaultValue="visual" lazyMount={false} unmountOnExit={false}>
      <Tabs.List aria-label="Budget Note view">
        <Tabs.Trigger value="visual">Editor</Tabs.Trigger>
        <Tabs.Trigger value="source">Markdown</Tabs.Trigger>
        <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content
        value="visual"
        css={{ "&[data-state=inactive]": { display: "none" } }}
      >
        <VisualEditor value={value} onChange={onChange} />
      </Tabs.Content>
      <Tabs.Content
        value="source"
        css={{ "&[data-state=inactive]": { display: "none" } }}
      >
        <Textarea
          aria-label="Budget Note Markdown source"
          minHeight="72"
          fontFamily="mono"
          placeholder="Write down what changed in your budget…"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </Tabs.Content>
      <Tabs.Content
        value="preview"
        minH="72"
        overflowX="auto"
        overflowWrap="anywhere"
        p="3"
        borderWidth="1px"
        rounded="md"
        lineHeight="1.6"
        css={{
          "& > * + *": { mt: "3" },
          "& :is(h1,h2,h3,h4,h5,h6)": { fontWeight: "semibold" },
          "& ul": { listStyle: "disc", ps: "6" },
          "& ol": { listStyle: "decimal", ps: "6" },
          "& a": { textDecoration: "underline" },
          "& th, & td": {
            px: "2",
            py: "1",
            borderWidth: "1px",
            textAlign: "start",
          },
          "& pre": { overflowX: "auto", p: "2", rounded: "md", bg: "bg.muted" },
        }}
      >
        {value.trim() ? (
          <ReactMarkdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={{ img: ({ alt }) => alt || "Image" }}
          >
            {value}
          </ReactMarkdown>
        ) : (
          <chakra.p color="fg.muted">
            Your Budget Note preview will appear here.
          </chakra.p>
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}
