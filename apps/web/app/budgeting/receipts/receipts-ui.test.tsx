import { afterEach, expect, mock, test } from "bun:test";
import { act, type ComponentProps } from "react";

const rowLinks = mock((_props: unknown) => {});
mock.module("next/link", () => ({ default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) => {
  rowLinks({ href: props.href, prefetch });
  return <a {...props} />;
} }));
import { createTestDom } from "@/components/shared/test-dom";

let params = new URLSearchParams();
const replace = mock((url: string) => { params = new URLSearchParams(url.split("?")[1]); });
const push = mock(() => {});
mock.module("next/navigation", () => ({
  useSearchParams: () => params,
  useParams: () => ({ id: "invoice-1" }),
  usePathname: () => "/budgeting/receipts",
  useRouter: () => ({ replace, push }),
}));
const dom = createTestDom();
const originalFetch = globalThis.fetch;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
});

function button(text: string) {
  return Array.from(dom.container.querySelectorAll("button")).find(el => el.textContent === text)!;
}

test("keeps merchant search and its pagination out of navigation and clears them on hide", async () => {
  params = new URLSearchParams("kind=invoice&cursor=page-two&q=old-merchant");
  window.history.replaceState(null, "", "/budgeting/receipts?" + params);
  replace.mockClear();
  const paths: string[] = [];
  globalThis.fetch = mock(async (path: any) => {
    paths.push(String(path));
    return Response.json({ receipts: [{ id: "doc-1", kind: "invoice", title: "Shop invoice", merchant: "Shop", date: "2026-11-01", createdAt: "2026-11-01", scanStatus: "archived", totalCents: 1250, currency: "CAD" }], next: "page-three" });
  }) as any;
  const { default: Page } = await import("./page");
  await dom.render(<Page />);
  expect(window.location.search).toBe("?kind=invoice&cursor=page-two");
  expect(rowLinks.mock.calls.some(([props]) => (props as any).href === "/budgeting/receipts/doc-1" && (props as any).prefetch === false)).toBe(true);
  const table = dom.container.querySelector('table[aria-label="Receipts and documents"]')!;
  expect(table).not.toBeNull();
  expect(Array.from(table.querySelectorAll("th")).map(header => header.textContent)).toEqual(["Document", "Type", "Date", "Status", "Total"]);
  const cells = Array.from(table.querySelectorAll("tbody tr td"));
  expect(cells).toHaveLength(5);
  cells.forEach((cell, index) => {
    const header = document.getElementById(cell.getAttribute("headers")!);
    expect(header).toBe(table.querySelectorAll("th")[index]);
    expect(header?.getAttribute("scope")).toBe("col");
  });
  const link = cells[0].querySelector("a")!;
  link.focus();
  expect(document.activeElement).toBe(link);
  expect(link.getAttribute("href")).toBe("/budgeting/receipts/doc-1");
  expect(table.querySelectorAll("tbody a")).toHaveLength(1);
  expect(paths).toEqual(["/api/v1/budgeting/receipts?cursor=page-two&kind=invoice"]);
  expect(dom.container.querySelector('a[href="/budgeting/receipts/doc-1"]')?.textContent).toContain("Private invoice");
  await dom.click(button("Reveal document details"));
  expect(paths).toHaveLength(2);
  expect(paths[1]).toContain("reveal=yes");
  expect(dom.container.querySelector('a[href="/budgeting/receipts/doc-1"]')?.textContent).toContain("Shop invoice");
  const input = dom.container.querySelector('input[aria-label="Search by merchant"]') as HTMLInputElement;
  expect(input.value).toBe("");
  await dom.type(input, "other");
  expect(paths).toHaveLength(2);
  await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await dom.render(<Page />);
  expect(paths[2]).toBe("/api/v1/budgeting/receipts?reveal=yes&q=other&kind=invoice");
  await dom.click(button("Next page"));
  expect(paths[3]).toBe("/api/v1/budgeting/receipts?reveal=yes&q=other&cursor=page-three&kind=invoice");
  await dom.click(button("Hide document details"));
  expect(paths[4]).toBe("/api/v1/budgeting/receipts?kind=invoice");
  expect(replace.mock.calls.map(([url]) => url)).toEqual(["/budgeting/receipts?kind=invoice"]);
  await dom.click(button("Reveal document details"));
  expect(paths[5]).toBe("/api/v1/budgeting/receipts?reveal=yes&kind=invoice");
  expect(dom.container.querySelector<HTMLInputElement>('input[aria-label="Search by merchant"]')?.value).toBe("");
  expect(paths).toHaveLength(6);
});

test("camera permission failure shows recovery, keeps scanner controls usable", async () => {
  const getUserMedia = mock(async () => { throw Error("Denied"); });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  const { ReceiptCameraScanner } = await import("./receipt-camera-scanner");
  const capture = mock(() => {});
  await dom.render(<ReceiptCameraScanner autoSubmit onCapture={capture} />);
  await dom.click(button("Start auto scan"));
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain("Check permission or use the photo upload");
  expect(button("Start auto scan")).toBeDefined();
  expect(capture).not.toHaveBeenCalled();
});

test("photo upload preserves multipart payload and pending feedback until save completes", async () => {
  params = new URLSearchParams();
  let finish!: (response: Response) => void;
  const writes: FormData[] = [];
  globalThis.fetch = mock(async (_path: any, options: any) => {
    if (options.method === "POST") {
      writes.push(options.body);
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return Response.json({ receipts: [], next: null });
  }) as any;
  const { default: Page } = await import("./page");
  await dom.render(<Page />);
  const input = dom.container.querySelector('input[aria-label="Take receipt photo"]') as HTMLInputElement;
  const photo = new File(["photo"], "receipt.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { configurable: true, value: [photo] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(writes).toHaveLength(1);
  expect(writes[0].get("kind")).toBe("receipt");
  expect((writes[0].get("photo") as File).name).toBe("receipt.jpg");
  expect(writes[0].get("id")).toBeTruthy();
  expect(dom.container.textContent).toContain("Saving receipt…");
  expect(input.disabled).toBe(true);
  expect(dom.container.querySelector("select")?.disabled).toBe(true);
  await act(async () => { finish(Response.json({ id: "saved-doc" })); });
  expect(push).toHaveBeenCalledWith("/budgeting/receipts/saved-doc");
  expect(dom.container.textContent).toContain("Take photo");
});


test("revealed invoice shows header facts, PDF link and labeled editor", async () => {
  globalThis.fetch = mock(async (path: any) => Response.json(String(path).includes("reveal=yes") ? {
    id: "invoice-1", kind: "invoice", merchant: "Example merchant", title: "Invoice", date: "2026-11-02",
    totalCents: 2500, currency: "CAD", scanStatus: "archived", scanProvenance: "ocr_completed", mime: "application/pdf", lines: [],
    createdAt: "2026-11-02", expense: null, invoiceNumber: "INV-1", dueDate: "2026-11-30",
  } : { id: "invoice-1", scanStatus: "archived" })) as any;
  const { default: Page } = await import("./[id]/page");
  await dom.render(<Page />);
  await dom.click(button("Reveal document"));
  expect(dom.container.querySelector("h1")?.textContent).toBe("Invoice");
  expect(dom.container.textContent).toContain("MerchantExample merchant");
  expect(dom.container.textContent).toContain("Date2026-11-02");
  expect(dom.container.textContent).toContain("Total$25.00");
  expect(dom.container.textContent).toContain("OCR completed");
  expect(dom.container.querySelector('a[href="/api/v1/budgeting/receipts/invoice-1/original"]')?.textContent).toBe("Download original PDF");
  await dom.click(button("Edit details"));
  const merchant = dom.container.querySelector('input[name="merchant"]') as HTMLInputElement;
  expect(merchant.value).toBe("Example merchant");
  expect(dom.container.querySelector(`label[for="${merchant.id}"]`)?.textContent).toBe("Merchant");
});

test.each(["POST", "GET"])("hiding a receipt during scan retry stops the private read while %s is pending", async (phase) => {
  const base = "/api/v1/budgeting/receipts/invoice-1";
  const metadata = { id: "invoice-1", kind: "invoice", scanStatus: "failed" };
  let finishScan: ((response: Response) => void) | undefined;
  let finishRefresh!: (response: Response) => void;
  let refreshSignal: AbortSignal | undefined;
  const revealed = {
    ...metadata, merchant: "Synthetic merchant", mime: "application/pdf", lines: [],
    createdAt: "2026-11-02", expense: null, totalCents: null,
  };
  const request = mock((path: string, options: RequestInit) => {
    if (path === base + "/scan") return new Promise<Response>(resolve => { finishScan = resolve; });
    if (path === base + "?reveal=yes" && finishScan) {
      refreshSignal = options.signal ?? undefined;
      return new Promise<Response>(resolve => { finishRefresh = resolve; });
    }
    return Promise.resolve(Response.json(path === base ? metadata : revealed));
  });
  globalThis.fetch = request as unknown as typeof fetch;
  const { default: Page } = await import("./[id]/page");
  await dom.render(<Page />);
  await dom.click(button("Reveal document"));
  await dom.click(button("Retry scan"));
  const settleScan = () => act(async () => finishScan!(Response.json({ ...metadata, scanStatus: "pending" })));
  if (phase === "GET") await settleScan();
  await dom.click(button("Hide document"));
  if (phase === "POST") await settleScan();
  else {
    expect(refreshSignal?.aborted).toBe(true);
    await act(async () => finishRefresh(Response.json(revealed)));
  }
  const paths = request.mock.calls.map(([path, options]) => options.method + " " + path);
  expect(paths).toEqual([
    "GET " + base,
    "GET " + base + "?reveal=yes",
    "POST " + base + "/scan",
    ...(phase === "GET" ? ["GET " + base + "?reveal=yes"] : []),
    "GET " + base,
  ]);
  expect(dom.container.textContent).toContain("Document content is hidden");
  expect(dom.container.textContent).not.toContain(revealed.merchant);
});

test("camera capture previews a JPEG and awaits upload before clearing it", async () => {
  const stop = mock(() => {});
  let allowCamera!: (stream: unknown) => void;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: mock(() => new Promise(resolve => { allowCamera = resolve; })),
  } });
  const videoPrototype = window.HTMLVideoElement.prototype;
  const canvasPrototype = window.HTMLCanvasElement.prototype;
  const overrides: [object, string, PropertyDescriptor | undefined][] = [];
  function override(target: object, key: string, value: unknown) {
    overrides.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  }
  override(videoPrototype, "srcObject", null);
  override(videoPrototype, "videoWidth", 640);
  override(videoPrototype, "videoHeight", 480);
  override(videoPrototype, "play", async () => {});
  override(canvasPrototype, "getContext", () => ({ drawImage() {} }));
  override(canvasPrototype, "toBlob", (callback: (blob: Blob) => void) => callback(new Blob(["image"], { type: "image/jpeg" })));
  let finish!: () => void;
  const capture = mock((_file: File) => new Promise<void>(resolve => { finish = resolve; }));
  try {
    const { ReceiptCameraScanner } = await import("./receipt-camera-scanner");
    await dom.render(<ReceiptCameraScanner onCapture={capture} />);
    await dom.click(button("Scan with camera"));
    await act(async () => allowCamera({ getTracks: () => [{ stop }] }));
    expect(button("Capture photo").disabled).toBe(false);
    await dom.click(button("Capture photo"));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dom.container.querySelector('img[alt="Captured receipt preview"]')).not.toBeNull();
    await dom.click(button("Use scan"));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0].type).toBe("image/jpeg");
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Retake").disabled).toBe(true);
    await act(async () => finish());
    expect(dom.container.querySelector('img[alt="Captured receipt preview"]')).toBeNull();
    expect(dom.container.querySelector('[role="status"]')?.textContent).toBe("Scan saved.");
  } finally {
    for (const [target, key, descriptor] of overrides.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
});

test("copy and CSV request all matching documents on click without using the page cursor", async () => {
  params = new URLSearchParams("kind=receipt");
  const visible = [
    { id: "copy-doc", title: 'Shop "One"', expense: null, totalCents: 1250 },
    { id: "bank", title: "Bank", expense: { bankAccount: "Bank" }, totalCents: null, scanProvenance: "ocr_completed" },
    { id: "cash", title: "Cash", expense: { bankAccount: null }, totalCents: null, scanStatus: "confirmed", scanProvenance: "upload_only" },
    { id: "failed", title: "Failed", expense: null, totalCents: null, scanStatus: "failed" },
    { id: "uploaded", title: "Upload", expense: null, totalCents: null, scanProvenance: "upload_only" },
    { id: "scanned", title: "Scan", expense: null, totalCents: null, scanProvenance: "ocr_completed" },
  ].map(row => ({
    kind: "receipt", merchant: "Shop", date: "2026-11-01", createdAt: "2026-11-01",
    scanStatus: "archived", currency: "CAD", ...row,
  }));
  const all = [...visible, { ...visible[0], id: "off-page", title: '="Older document"' }];
  const request = mock(async (path: string) => {
    if (path.endsWith("format=ids")) return Response.json({ ids: all.map(row => row.id) });
    if (path.endsWith("format=csv")) return Response.json({
      rows: all.map(({ expense, ...row }) => ({
        ...row,
        expenseStatus: expense?.bankAccount ? "matched" : expense ? "cash" : null,
      })),
    });
    return Response.json({ receipts: visible, next: "more" });
  });
  globalThis.fetch = request as unknown as typeof fetch;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = mock(async (_value: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const click = window.HTMLAnchorElement.prototype.click;
  let exported!: Blob;
  URL.createObjectURL = blob => { exported = blob as Blob; return "blob:export"; };
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  try {
    const { default: Page } = await import("./page");
    await dom.render(<Page />);
    await dom.click(button("Reveal document details"));
    expect(request).toHaveBeenCalledTimes(2);
    const input = dom.container.querySelector<HTMLInputElement>('input[aria-label="Search by merchant"]')!;
    await dom.type(input, "shop");
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await dom.render(<Page />);
    await dom.click(button("Next page"));
    await dom.render(<Page />);
    await dom.click(dom.container.querySelector('button[aria-label="Copy"]')!);
    expect(writeText).toHaveBeenCalledWith("copy-doc\nbank\ncash\nfailed\nuploaded\nscanned\noff-page");
    await dom.click(dom.container.querySelector('button[aria-label="Download"]')!);
    expect(await exported.text()).toContain('"copy-doc","Shop ""One""","Receipt"');
    const csvRows = (await exported.text()).split("\r\n").slice(1);
    expect(csvRows).toHaveLength(7);
    expect(csvRows.at(-1)).toContain(`"off-page","'=""Older document"""`);
    const visibleStatuses = Array.from(dom.container.querySelectorAll("tbody tr")).map(row => row.querySelectorAll("td")[3].textContent);
    expect(visibleStatuses).toEqual(["archived", "Matched to bank", "Cash expense", "failed", "Upload only", "OCR completed"]);
    visibleStatuses.forEach((status, index) => expect(csvRows[index]).toContain(`,"${status}",`));
    expect(dom.container.textContent).toContain("6 documents on this page");
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/budgeting/receipts?kind=receipt",
      "/api/v1/budgeting/receipts?reveal=yes&kind=receipt",
      "/api/v1/budgeting/receipts?reveal=yes&q=shop&kind=receipt",
      "/api/v1/budgeting/receipts?reveal=yes&q=shop&cursor=more&kind=receipt",
      "/api/v1/budgeting/receipts/export?reveal=yes&q=shop&kind=receipt&format=ids",
      "/api/v1/budgeting/receipts/export?reveal=yes&q=shop&kind=receipt&format=csv",
    ]);
  } finally {
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    window.HTMLAnchorElement.prototype.click = click;
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("receipt links, exports and cursors follow successful results for the active query", async () => {
  params = new URLSearchParams();
  const requests: { path: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const uploads: FormData[] = [];
  const exportPaths: string[] = [];
  globalThis.fetch = mock((path: string, options: RequestInit) => {
    if (options.method === "POST") {
      uploads.push(options.body as FormData);
      return Promise.resolve(Response.json({ id: "new-upload", scanStatus: "archived" }));
    }
    expect(options.method).toBe("GET");
    if (path.includes("/receipts/export?")) {
      exportPaths.push(path);
      if (path.endsWith("format=ids")) return Promise.resolve(Response.json({ ids: ["beta"] }));
      return Promise.resolve(Response.json({ rows: [{
        id: "beta-page-two", kind: "receipt", title: "beta-page-two", merchant: "", date: null,
        createdAt: "2026-11-01", scanStatus: "archived", totalCents: null, currency: "CAD", expenseStatus: null,
      }] }));
    }
    return new Promise<Response>(resolve => requests.push({ path, signal: options.signal!, resolve }));
  }) as unknown as typeof fetch;
  const documents = (id: string, next: string | null = null) => Response.json({
    receipts: [{ id, kind: "receipt", title: id, createdAt: "2026-11-01", scanStatus: "archived", totalCents: null, currency: "CAD" }],
    next,
  });
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = mock(async (_value: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const click = window.HTMLAnchorElement.prototype.click;
  const downloads: Blob[] = [];
  URL.createObjectURL = blob => { downloads.push(blob as Blob); return "blob:export"; };
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  try {
    const { default: Page } = await import("./page");
    const base = "/api/v1/budgeting/receipts";
    const path = (index: number, query = "") => expect(requests[index]?.path).toBe(base + query);
    const settle = (index: number, response: Response) => act(async () => requests[index]!.resolve(response));
    const copy = () => dom.container.querySelector<HTMLButtonElement>('button[aria-label="Copy"], button[aria-label="Copied"]')!;
    const download = () => dom.container.querySelector<HTMLButtonElement>('button[aria-label="Download"]')!;
    const links = () => [...dom.container.querySelectorAll('tbody a')].map(link => link.getAttribute("href"));
    const next = () => button("Next page");
    const unavailable = async (state: "loading" | "failed", copies = 0, exports = 0) => {
      expect(links()).toEqual([]);
      expect(copy().disabled).toBe(true);
      expect(download().disabled).toBe(true);
      expect(next()).toBeUndefined();
      expect(dom.container.textContent).not.toContain("documents on this page");
      const roles = dom.container.querySelectorAll(state === "loading" ? '[role="status"]' : '[role="alert"]');
      expect([...roles].map(element => element.textContent))
        .toContain(state === "loading" ? "Loading budget data…" : "Could not load receipts");
      await dom.click(copy());
      await dom.click(download());
      expect(writeText).toHaveBeenCalledTimes(copies);
      expect(downloads).toHaveLength(exports);
    };
    const search = async (value: string) => {
      const input = dom.container.querySelector<HTMLInputElement>('input[aria-label="Search by merchant"]')!;
      await dom.type(input, value);
      await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await dom.render(<Page />);
    };

    await dom.render(<Page />);
    path(0);
    await settle(0, documents("old", "old-next"));
    await dom.click(button("Reveal document details"));
    path(1, "?reveal=yes");
    await settle(1, documents("old", "old-next"));
    expect(links()).toEqual(["/budgeting/receipts/old"]);
    expect(next()).toBeDefined();

    await search("alpha");
    path(2, "?reveal=yes&q=alpha");
    await unavailable("loading");

    await search("");
    path(3, "?reveal=yes");
    expect(requests[2]!.signal.aborted).toBe(true);
    await unavailable("loading");

    await search("beta");
    path(4, "?reveal=yes&q=beta");
    expect(requests[3]!.signal.aborted).toBe(true);
    await settle(3, documents("late-return", "return-next"));
    await settle(2, documents("late-alpha", "alpha-next"));
    await unavailable("loading");

    await settle(4, documents("beta", "beta-next"));
    expect(links()).toEqual(["/budgeting/receipts/beta"]);
    await dom.click(copy());
    expect(writeText).toHaveBeenCalledWith("beta");

    await dom.click(next());
    await dom.render(<Page />);
    path(5, "?reveal=yes&q=beta&cursor=beta-next");
    await unavailable("loading", 1);
    await settle(5, Response.json({ message: "Could not load receipts" }, { status: 503 }));
    await unavailable("failed", 1);
    expect(button("First page").disabled).toBe(false);
    await dom.click(button("Retry"));
    path(6, "?reveal=yes&q=beta&cursor=beta-next");
    await unavailable("loading", 1);
    await settle(6, documents("beta-page-two"));
    expect(links()).toEqual(["/budgeting/receipts/beta-page-two"]);
    await dom.click(download());
    expect(downloads).toHaveLength(1);
    expect(await downloads[0]!.text()).toContain('"beta-page-two"');
    expect(next()).toBeUndefined();
    const upload = dom.container.querySelector<HTMLInputElement>('input[aria-label="Upload documents"]')!;
    const photo = new File(["photo"], "receipt.jpg", { type: "image/jpeg" });
    Object.defineProperty(upload, "files", { configurable: true, value: [photo] });
    await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
    expect(uploads).toHaveLength(1);
    path(7, "?reveal=yes&q=beta&cursor=beta-next");
    expect(links()).toEqual(["/budgeting/receipts/beta-page-two"]);
    expect(copy().disabled).toBe(false);
    expect(download().disabled).toBe(false);
    await settle(7, Response.json({ message: "Could not load receipts" }, { status: 503 }));
    await unavailable("failed", 1, 1);
    await dom.click(button("Retry"));
    path(8, "?reveal=yes&q=beta&cursor=beta-next");
    await unavailable("loading", 1, 1);
    await settle(8, documents("updated-page-two"));
    expect(links()).toEqual(["/budgeting/receipts/updated-page-two"]);
    expect(requests).toHaveLength(9);
    expect(exportPaths).toEqual([
      base + "/export?reveal=yes&q=beta&format=ids",
      base + "/export?reveal=yes&q=beta&format=csv",
    ]);
  } finally {
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    window.HTMLAnchorElement.prototype.click = click;
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("receipt export errors remain retryable and hiding details aborts private results", async () => {
  params = new URLSearchParams();
  const exports: { signal: AbortSignal; finish: (response: Response) => void }[] = [];
  globalThis.fetch = mock((path: string, options: RequestInit) => {
    if (path.includes("/receipts/export?")) {
      return new Promise<Response>(finish => exports.push({ signal: options.signal!, finish }));
    }
    return Promise.resolve(Response.json({ receipts: [], next: null }));
  }) as unknown as typeof fetch;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = mock(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const { default: Page } = await import("./page");
    const copy = () => dom.container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!;
    await dom.render(<Page />);
    await dom.click(button("Reveal document details"));
    await dom.click(copy());
    expect(copy().disabled).toBe(true);
    expect(dom.container.textContent).toContain("Preparing export");
    await act(async () => exports[0].finish(Response.json({ message: "Receipt export unavailable." }, { status: 503 })));
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe("Receipt export unavailable.");
    expect(copy().disabled).toBe(false);
    expect(writeText).not.toHaveBeenCalled();

    await dom.click(copy());
    expect(exports).toHaveLength(2);
    expect(dom.container.querySelector('[role="alert"]')).toBeNull();
    await dom.click(button("Hide document details"));
    expect(exports[1].signal.aborted).toBe(true);
    await act(async () => exports[1].finish(Response.json({ ids: ["private-id"] })));
    expect(writeText).not.toHaveBeenCalled();
    expect(copy()).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("upload entry opens the existing scanner and file picker without reading the receipt list", async () => {
  params = new URLSearchParams("upload=yes");
  const fetcher = mock(async () => Response.json({ receipts: [], next: null }));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const { default: Page } = await import("./page");
  await dom.render(<Page />);
  expect(dom.container.querySelector("h1")?.textContent).toBe("Upload document");
  expect(button("Start auto scan")).toBeDefined();
  expect(dom.container.querySelector('input[aria-label="Upload documents"]')).not.toBeNull();
  expect(dom.container.querySelector('a[href="/budgeting/documents"]')).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
