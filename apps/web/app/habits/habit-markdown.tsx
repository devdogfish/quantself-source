"use client";
import { Box } from "@chakra-ui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Owner-authored documents remain untrusted: skip raw HTML and retain safe URL handling.
export function HabitMarkdown({ children }: { children: string }) {
  return (
    <Box
      overflowX="auto"
      textStyle="sm"
      lineHeight="relaxed"
      css={{
        "& h1, & h2": { mt: "6", mb: "2", fontWeight: "semibold" },
        "& h1": { fontSize: "lg" },
        "& h2": { fontSize: "md" },
        "& h1:first-child, & h2:first-child": { mt: "0" },
        "& h3": { mt: "4", mb: "1", fontWeight: "medium" },
        "& p, & ul, & ol": { my: "2" },
        "& ul": { listStyleType: "disc", pl: "5" },
        "& ol": { listStyleType: "decimal", pl: "5" },
        "& li": { my: "0.5" },
        "& blockquote": {
          my: "3",
          borderLeftWidth: "2px",
          pl: "3",
          color: "fg.muted",
        },
        "& strong": { fontWeight: "semibold" },
        "& a": { textDecoration: "underline", textUnderlineOffset: "4px" },
        "& code": {
          borderRadius: "sm",
          bg: "bg.muted",
          px: "1",
          py: "0.5",
          fontFamily: "mono",
          fontSize: "xs",
        },
        "& hr": { my: "4" },
        "& table": {
          my: "3",
          width: "full",
          borderCollapse: "collapse",
          textAlign: "left",
        },
        "& th, & td": {
          borderBottomWidth: "1px",
          py: "1.5",
          pr: "3",
          verticalAlign: "top",
        },
        "& th": { fontWeight: "medium" },
      }}
    >
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}
