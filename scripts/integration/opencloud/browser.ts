import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkBrowser(app: { fetch: (request: Request) => Response | Promise<Response> }, captureId: string, image: Uint8Array) {
  const repo = process.env.INTEGRATION_REPO_ROOT!, dir = process.env.INTEGRATION_DIR!;
  const outdir = join(dir, "ui"); await mkdir(outdir);
  const built = await Bun.build({
    entrypoints: [join(repo, "apps/web/scripts/opencloud-ui-fixture.tsx")], outdir, target: "browser", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "synthetic-router", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, () => ({ path: join(repo, "apps/web/scripts/opencloud-ui-navigation.tsx") }));
    } }],
  });
  assert(built.success, built.logs.map(String).join("\n"));
  const script = built.outputs.find(output => output.path.endsWith(".js"))!;
  const styles = built.outputs.filter(output => output.path.endsWith(".css"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 19301, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return app.fetch(request);
    const output = built.outputs.find(output => `/static/${output.path.split("/").at(-1)}` === path);
    if (output) return new Response(Bun.file(output.path));
    return new Response(`<!doctype html><html><head>${styles.map(output => `<link rel="stylesheet" href="/static/${output.path.split("/").at(-1)}">`).join("")}</head><body><div id="root"></div><script type="module" src="/static/${script.path.split("/").at(-1)}"></script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  const { chromium } = await import(join(dir, "node_modules/playwright/index.mjs"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    page.on("pageerror", (error: Error) => console.error("UI error", error.message));
    await page.goto("http://localhost:19301/budgeting/receipts");
    await page.getByText("Archive originals only — no OCR", { exact: true }).click();
    const input = page.getByLabel("Upload documents", { exact: true });
    await input.setInputFiles({ name: "browser-receipt.png", mimeType: "image/png", buffer: Buffer.from(image) });
    await page.getByText(/1 of 1 processed · 1 archived/).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Reveal document details", exact: true }).click();
    const documentLink = page.getByRole("link", { name: /browser-receipt/ }).first();
    await documentLink.click();
    await page.getByRole("button", { name: "Reveal document", exact: true }).click();
    await page.getByRole("button", { name: /original/i }).click();
    const original = page.locator('img[src*="/original"]');
    await original.waitFor();
    await page.waitForFunction(() => { const image = document.querySelector('img[src*="/original"]') as HTMLImageElement | null; return image?.complete && image.naturalWidth > 0; });
    await page.screenshot({ path: join(dir, "receipt-ui.png"), fullPage: true });
    await page.goto(`http://localhost:19301/audio?capture=${captureId}`);
    await page.getByRole("button", { name: /play/i }).click();
    await page.waitForFunction(() => { const audio = document.querySelector("audio"); return audio && !audio.paused && audio.currentTime > 0; });
    await page.locator('[role="slider"]').first().focus();
    await page.keyboard.press("End");
    // Browser-controlled seek exercises HTTP Range and the actual AudioPlayer control.
    await page.locator('[role="slider"]').first().press("ArrowLeft");
    await page.waitForFunction(() => { const audio = document.querySelector("audio"); return audio && audio.currentTime > 60; });
    await page.screenshot({ path: join(dir, "recording-ui.png"), fullPage: true });
    await writeFile(join(dir, "browser-results.json"), JSON.stringify({ receiptUploadOpen: true, audioPlaySeek: true, ui: "Unmodified ReceiptLibraryPage, ReceiptDetailPage and AudioPlayer; synthetic router/auth harness" }, null, 2));
  } catch (error) {
    console.error("Browser failure:", await page.locator("body").innerText());
    await page.screenshot({ path: join(dir, "browser-failure.png"), fullPage: true });
    throw error;
  } finally { await browser.close(); server.stop(true); }
}
