"use client";

import { Spinner, chakra } from "@chakra-ui/react";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { ResumePdfViewerProps } from "./resume-pdf-viewer";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

const assets = `/pdfjs/${pdfjs.version}/`;
pdfjs.GlobalWorkerOptions.workerSrc = assets + "pdf.worker.min.mjs";
const options = {
  cMapUrl: assets + "cmaps/",
  cMapPacked: true,
  standardFontDataUrl: assets + "standard_fonts/",
  wasmUrl: assets + "wasm/",
  iccUrl: assets + "iccs/",
  isEvalSupported: false,
  useSystemFonts: false,
};
const boundedRatio = (ratio: number) => Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;

function LoadingPdf() {
  return (
    <chakra.div
      role="status"
      css={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        padding: "1.5rem",
        fontSize: "sm",
        color: "fg.muted",
      }}
    >
      <Spinner />
      Loading PDF…
    </chakra.div>
  );
}

export default function ResumePdfDocument({ pdfUrl, scrollRatio = 0, onScrollRatioChange, title = "Résumé PDF", css, maxPageWidth }: ResumePdfViewerProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const desiredRatio = useRef(boundedRatio(scrollRatio));
  const synchronizedTop = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState(false);
  const [pageRatios, setPageRatios] = useState<Record<number, number>>({});
  const pageWidth = maxPageWidth ? Math.min(width, maxPageWidth) : width;

  const applyRatio = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const top = desiredRatio.current * Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - top) < 1) return;
    synchronizedTop.current = top;
    element.scrollTop = top;
  }, []);

  useLayoutEffect(() => {
    desiredRatio.current = boundedRatio(scrollRatio);
    applyRatio();
  }, [scrollRatio, applyRatio]);

  useEffect(() => {
    const element = viewport.current;
    const document = content.current;
    if (!element || !document) return;
    const resize = new ResizeObserver(() => {
      setWidth(Math.max(0, element.clientWidth - (maxPageWidth ? 48 : 12)));
      applyRatio();
    });
    resize.observe(element);
    resize.observe(document);
    setWidth(Math.max(0, element.clientWidth - (maxPageWidth ? 48 : 12)));
    return () => resize.disconnect();
  }, [applyRatio, maxPageWidth]);

  function onScroll() {
    const element = viewport.current;
    if (!element) return;
    const expectedTop = synchronizedTop.current;
    synchronizedTop.current = null;
    if (expectedTop !== null && Math.abs(expectedTop - element.scrollTop) < 1) return;
    const range = element.scrollHeight - element.clientHeight;
    const ratio = range > 0 ? boundedRatio(element.scrollTop / range) : 0;
    desiredRatio.current = ratio;
    onScrollRatioChange?.(ratio);
  }

  return (
    <chakra.div
      ref={viewport}
      role="region"
      aria-label={title}
      tabIndex={0}
      onScroll={onScroll}
      css={{
        height: "100%",
        minHeight: 0,
        overflow: "auto",
        overscrollBehavior: "contain",
        rounded: "lg",
        borderWidth: "1px",
        bg: "bg.subtle",
        overflowAnchor: "none",
        ...css,
      }}
    >
      <chakra.div
        ref={content}
        css={{
          display: "flex",
          minHeight: "100%",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.375rem",
          ...(maxPageWidth ? { padding: "1.5rem" } : {}),
        }}
      >
        <StyledDocument
          file={pdfUrl}
          options={options}
          suspense={false}
          loading={<LoadingPdf />}
          error={
            <chakra.p role="alert" css={{ padding: "1.5rem", fontSize: "sm", color: "fg.error" }}>
              Could not display this PDF. Try rendering the preview again.
            </chakra.p>
          }
          onLoadSuccess={({ numPages }) => { setPages(numPages); setError(false); }}
          onLoadError={() => setError(true)}
          externalLinkTarget="_blank"
          externalLinkRel="noopener noreferrer nofollow"
          css={{
            display: "flex",
            width: "100%",
            flexDirection: maxPageWidth ? "row" : "column",
            flexWrap: maxPageWidth ? "wrap" : "nowrap",
            justifyContent: "center",
            alignItems: maxPageWidth ? "flex-start" : "center",
            gap: maxPageWidth ? "1.5rem" : "0.5rem",
          }}
        >
          {width > 0 &&
            !error &&
            Array.from({ length: pages }, (_, index) => {
              const pageNumber = index + 1;
              return (
                <chakra.div
                  key={pageNumber}
                  css={{ width: maxPageWidth ? undefined : "100%", background: "white", boxShadow: "sm" }}
                  style={{ width: maxPageWidth ? pageWidth : undefined, minHeight: pageWidth * (pageRatios[pageNumber] ?? Math.SQRT2) }}
                  aria-label={`Page ${pageNumber} of ${pages}`}
                >
                  <StyledPage
                    pageNumber={pageNumber}
                    width={pageWidth}
                    devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
                    loading={<LoadingPdf />}
                    error={
                      <chakra.p
                        role="alert"
                        css={{
                          padding: "1.5rem",
                          fontSize: "sm",
                          color: "fg.error",
                        }}
                      >
                        Could not display this page.
                      </chakra.p>
                    }
                    onLoadSuccess={page => {
                const { width, height } = page.getViewport({ scale: 1 });
                setPageRatios(previous => ({ ...previous, [pageNumber]: height / width }));
              }}
                    onRenderSuccess={applyRatio}
                    renderForms={false}
                    css={{ "& canvas": { maxWidth: "100%" } }}
                  />
                </chakra.div>
              );
            })}
        </StyledDocument>
      </chakra.div>
    </chakra.div>
  );
}

const StyledDocument = chakra(Document);
const StyledPage = chakra(Page);
