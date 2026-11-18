"use client";

import { Box, Text } from "@chakra-ui/react";
import { Document, Page, pdfjs } from "react-pdf";

const assets = `/pdfjs/${pdfjs.version}/`;
pdfjs.GlobalWorkerOptions.workerSrc = assets + "pdf.worker.min.mjs";
const options = {
  cMapUrl: assets + "cmaps/",
  cMapPacked: true,
  standardFontDataUrl: assets + "standard_fonts/",
  wasmUrl: assets + "wasm/",
  iccUrl: assets + "iccs/",
  isEvalSupported: false,
};

export default function DocumentPdfPreview({ url, onPages }: { url: string; onPages: (pages: number) => void }) {
  return (
    <Box h="full" overflow="auto" tabIndex={0} aria-label="PDF first page" css={{ "& canvas": { maxWidth: "100%", height: "auto !important" } }}>
      <Document file={url} options={options} suspense={false}
        loading={<Text role="status">Loading preview…</Text>}
        error={<Text role="alert">Could not display the PDF preview.</Text>}
        onLoadSuccess={({ numPages }) => onPages(numPages)}>
        <Page pageNumber={1} width={500} renderTextLayer={false} renderAnnotationLayer={false} />
      </Document>
    </Box>
  );
}
