"use client";

import { useEffect, useRef, useState } from "react";
import { copyExportText, downloadText } from "@/components/shared/data-toolbar";

type ExportRow = { id: string; title: string };

export function useInventoryPanelExport(
  loadRows: (signal: AbortSignal) => Promise<ExportRow[]>,
  fileName: string,
) {
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => active.current?.abort(), []);

  async function run(format: "copy" | "csv") {
    if (active.current) return false;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError("");

    try {
      if (format === "copy") {
        await copyExportText(async () =>
          (await loadRows(controller.signal)).map(({ id }) => id).join("\n"),
        );
      } else {
        const rows = await loadRows(controller.signal);
        if (!controller.signal.aborted) {
          downloadText(inventoryPanelCsv(rows), fileName, "text/csv");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : "";
        setError(detail ? `Export failed. ${detail}` : "Export failed. Try again.");
      }
      return false;
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return {
    error,
    pending,
    copy: () => run("copy"),
    download: async () => { await run("csv"); },
  };
}

export function inventoryPanelCsv(items: ExportRow[]) {
  const cell = (value: string) => {
    const safe = /^(?:[\t\r\n]|[\s\u0000-\u001f]*[=+\-@])/u.test(value)
      ? `'${value}`
      : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [
    "id,title",
    ...items.map((item) => `${cell(item.id)},${cell(item.title)}`),
  ].join("\r\n");
}
