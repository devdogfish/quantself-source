"use client";

// One toolbar for every data panel: search · filter segments (optional) · count · copy · download
import { useEffect, useRef, useState } from "react";
import { HStack, IconButton, Input, InputGroup, SegmentGroup, Text } from "@chakra-ui/react";
import { Check, Copy, Download, Search, X } from "lucide-react";
import { Tooltip } from "@/components/chakra/tooltip";

export function DataToolbar<V extends string>({
  query, onQuery, placeholder, queryDisabled, segments, value, onValue, count, copyLabel, onCopy, downloadLabel, onDownload, exportsDisabled = false,
}: {
  exportsDisabled?: boolean;
  query: string;
  queryDisabled?: boolean;
  onQuery: (q: string) => void;
  placeholder: string;
  segments?: { value: V; label: string }[];
  value?: V;
  onValue?: (v: V) => void;
  count: string;
  copyLabel: string;
  onCopy: () => Promise<void | false> | void | false;
  downloadLabel: string;
  onDownload: () => Promise<void> | void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    setCopied(false);
    clearTimeout(timer.current);
    if ((await onCopy()) === false) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };
  return (
    <HStack gap="2" px="2" py="1.5" borderBottomWidth="1px" bg="bg.subtle" wrap="wrap">
      <InputGroup
        flex="1" minW="40" maxW="72" startElement={<Search size={14} />}
        endElement={query ? <IconButton aria-label="Clear search" size="2xs" variant="ghost" onClick={() => onQuery("")}><X /></IconButton> : undefined}
      >
        <Input disabled={queryDisabled} size="xs" placeholder={placeholder} aria-label={placeholder} value={query} onChange={(e) => onQuery(e.target.value)} />
      </InputGroup>
      {segments && (
        <SegmentGroup.Root size="xs" value={value} onValueChange={(e) => onValue?.(e.value as V)}>
          <SegmentGroup.Indicator />
          <SegmentGroup.Items items={segments} />
        </SegmentGroup.Root>
      )}
      <Text textStyle="xs" color="fg.muted" ms="auto" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">{count}</Text>
      <Tooltip content={copyLabel}>
        <IconButton type="button" aria-label={copied ? "Copied" : "Copy"} size="xs" variant="ghost" disabled={exportsDisabled} onClick={copy}>{copied ? <Check /> : <Copy />}</IconButton>
      </Tooltip>
      <Tooltip content={downloadLabel}>
        <IconButton type="button" aria-label="Download" size="xs" variant="ghost" disabled={exportsDisabled} onClick={onDownload}><Download /></IconButton>
      </Tooltip>
    </HStack>
  );
}

export async function copyExportText(load: () => Promise<string>) {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard access is unavailable.");
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    // Start the write while the browser still recognizes the user's click.
    const content = load().then((value) => new Blob([value], { type: "text/plain" }));
    try {
      await Promise.all([content, clipboard.write([new ClipboardItem({ "text/plain": content })])]);
    } catch (error) {
      // The clipboard API can throw before Promise.all attaches a handler.
      void content.catch(() => {});
      throw error;
    }
  } else {
    await clipboard.writeText(await load());
  }
}

export function downloadText(text: string, fileName: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
  URL.revokeObjectURL(url);
}
