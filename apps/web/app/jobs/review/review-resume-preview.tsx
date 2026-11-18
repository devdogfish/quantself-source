"use client";

import { Button, CloseButton, Dialog, HStack, Portal, Stack, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { ResumePdfViewer } from "../resume-pdf-viewer";

const viewerCss = { height: "100%", border: "none", rounded: "none", bg: "transparent", "& [aria-label^='Page']": { boxShadow: "lg", rounded: "sm" } };
const maxPageWidth = 820;

/** Full-page lightbox over the review session. Rendered only while open, so the PDF is built on demand. */
export function ResumePreviewDialog({ open, onClose, company, markdown, pdfUrl }: { open: boolean; onClose: () => void; company: string; markdown: string; pdfUrl: string | null }) {
  return (
    <Dialog.Root open={open} size="full" scrollBehavior="inside" lazyMount unmountOnExit onOpenChange={({ open }) => { if (!open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.700" />
        <Dialog.Positioner>
          <Dialog.Content bg="transparent" shadow="none" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <HStack px="6" h="12" flexShrink={0} justify="space-between" color="white">
              <Dialog.Title textStyle="sm" fontWeight="medium">{company} résumé · PDF preview</Dialog.Title>
              <Dialog.CloseTrigger asChild position="static"><CloseButton size="sm" variant="ghost" color="white" _hover={{ bg: "whiteAlpha.200" }} /></Dialog.CloseTrigger>
            </HStack>
            <Dialog.Body p="0" flex="1" minH="0" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
              <ReviewResumePreview company={company} markdown={markdown} pdfUrl={pdfUrl} />
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ReviewResumePreview({ company, markdown, pdfUrl }: { company: string; markdown: string; pdfUrl: string | null }) {
  if (pdfUrl) return <ResumePdfViewer pdfUrl={pdfUrl} title={`${company} résumé PDF`} css={viewerCss} maxPageWidth={maxPageWidth} />;
  if (!markdown.trim()) return <Text textStyle="sm" color="whiteAlpha.800" textAlign="center" py="16">No full résumé saved for this revision.</Text>;
  return <DraftPreview key={markdown} company={company} markdown={markdown} />;
}

function DraftPreview({ company, markdown }: { company: string; markdown: string }) {
  const [preview, setPreview] = useState<string | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void import("@/lib/jobs-draft-pdf")
      .then(({ buildJobsDraftPdf }) => active ? buildJobsDraftPdf(markdown) : undefined)
      .then(bytes => {
        if (!active || !bytes) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
        setPreview(url);
      })
      .catch(() => { if (active) setPreview("failed"); });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [markdown, attempt]);

  if (preview === "failed") return (
    <Stack py="16" align="center" color="white">
      <Text role="alert" textStyle="sm" color="red.300">Could not render the draft PDF.</Text>
      <Button size="xs" variant="outline" onClick={() => { setPreview(null); setAttempt(attempt + 1); }}>Retry preview</Button>
    </Stack>
  );
  if (!preview) return <Text role="status" textStyle="sm" color="whiteAlpha.800" textAlign="center" py="16">Rendering draft PDF…</Text>;
  return (
    <Stack gap="0" h="full">
      <Text textStyle="xs" color="whiteAlpha.700" textAlign="center" pb="1">Draft PDF · contact details and tracking links are added for submission</Text>
      <ResumePdfViewer pdfUrl={preview} title={`${company} draft résumé PDF`} css={viewerCss} maxPageWidth={maxPageWidth} />
    </Stack>
  );
}
