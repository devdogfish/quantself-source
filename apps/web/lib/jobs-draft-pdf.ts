import fontkit from "@pdf-lib/fontkit";
import { fromMarkdown } from "mdast-util-from-markdown";
import { PDFDocument, rgb } from "pdf-lib";

type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];
type MarkdownChild = MarkdownNode | { type: string; value?: string; children?: MarkdownChild[] };

const pageSize: [number, number] = [612, 792];
const inset = 46;
const ink = rgb(0.1, 0.1, 0.1);

function plainText(node: MarkdownChild): string {
  if (node.type === "break") return " ";
  if ("children" in node && node.children) return node.children.map(plainText).join("");
  return "value" in node ? node.value ?? "" : "";
}

/** Draft previews use the saved portable document. Contact placeholders belong to the submission PDF. */
export async function renderJobsDraftPdf(markdown: string, fontBytes: Uint8Array) {
  const source = markdown.replace(/^# \{\{fullName\}\}\s+\{\{contact\}\}\s*/u, "# Résumé\n\n");
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const fontWidth = (value: string, size: number) => font.widthOfTextAtSize(value, size);
  let page = pdf.addPage(pageSize);
  let top = pageSize[1] - inset;

  function place(text: string, size: number, indent: number, before: number, after: number) {
    const lineHeight = size * 1.38;
    const maxWidth = pageSize[0] - 2 * inset - indent;
    const lines: string[] = [];
    let line = "";
    for (const word of text.trim().split(/\s+/u)) {
      const next = line ? `${line} ${word}` : word;
      if (fontWidth(next, size) <= maxWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      if (fontWidth(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      for (const character of word) {
        if (fontWidth(line + character, size) > maxWidth && line) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    if (line) lines.push(line);
    if (!lines.length) return;
    if (top - before - lineHeight < inset) {
      page = pdf.addPage(pageSize);
      top = pageSize[1] - inset;
    }
    top -= before;
    for (const text of lines) {
      if (top - lineHeight < inset) {
        page = pdf.addPage(pageSize);
        top = pageSize[1] - inset;
      }
      page.drawText(text, { font, size, color: ink, x: inset + indent, y: top - size });
      top -= lineHeight;
    }
    top -= after;
  }

  function render(block: MarkdownNode, depth = 0, marker = "") {
    const indent = Math.min(depth, 6) * 12;
    if (block.type === "list") {
      const start = block.start ?? 1;
      block.children.forEach((item, index) => {
        const prefix = block.ordered ? `${start + index}. ` : "• ";
        item.children.forEach((content, childIndex) => render(content, depth + 1, childIndex === 0 ? prefix : ""));
      });
    } else if (block.type === "blockquote") {
      block.children.forEach(child => render(child, depth + 1));
    } else if (block.type === "heading") {
      const size = block.depth === 1 ? 25 : block.depth === 2 ? 15 : 12;
      place(plainText(block), size, indent, block.depth === 1 ? 0 : 8, 4);
    } else if (block.type === "paragraph" || block.type === "code") {
      place(marker + plainText(block), 10, indent, 0, marker ? 2 : 5);
    }
  }

  for (const node of fromMarkdown(source).children) render(node);
  return pdf.save();
}

let fontBytes: Promise<Uint8Array> | undefined;

export async function buildJobsDraftPdf(markdown: string) {
  fontBytes ??= fetch(new URL("./fonts/inter-latin-500-normal.ttf", import.meta.url)).then(async response => {
    if (!response.ok) throw new Error("Draft PDF font failed to load");
    return new Uint8Array(await response.arrayBuffer());
  }).catch(error => {
    fontBytes = undefined;
    throw error;
  });
  return renderJobsDraftPdf(markdown, await fontBytes);
}
