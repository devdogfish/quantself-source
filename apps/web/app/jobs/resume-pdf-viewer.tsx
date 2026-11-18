"use client";

import { Spinner, chakra, type SystemStyleObject } from "@chakra-ui/react";

import dynamic from "next/dynamic";

export type ResumePdfViewerProps = {
  /** The parent owns this URL and revokes it after replacing or closing the preview. */
  pdfUrl: string;
  scrollRatio?: number;
  onScrollRatioChange?: (ratio: number) => void;
  title?: string;
  /** When set, pages render at most this wide and wrap into columns if the viewport has room. */
  maxPageWidth?: number;
  css?: SystemStyleObject;
};

const PdfDocument = dynamic(() => import("./resume-pdf-document"), {
  ssr: false,
  loading: () => (
    <chakra.div
      role="status"
      css={{
        display: "flex",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        fontSize: "sm",
        color: "fg.muted",
      }}
    >
      <Spinner />
      Loading PDF…
    </chakra.div>
  ),
});

export function ResumePdfViewer(props: ResumePdfViewerProps) {
  return <PdfDocument key={props.pdfUrl} {...props} />;
}
