export const maxResumeMarkdown = 48_000;
export const resumeHeader = "# {{fullName}}\n\n{{contact}}\n\n";

const email = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu;
const phone = /(?:^|[^\w])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?|[2-9]\d{2}[ .-]?)[2-9]\d{2}[ .-]?\d{4}(?!\w)/m;
const forbidden = /[<>\u0000-\u0008\u000b-\u001f\u007f]|!\s*\[|\{\{|\}\}|\{:[^}]*\}|&(?!lt;|gt;)(?:#(?:x[\da-f]+|\d+)|[a-z]+);|\b(?:file|javascript|vbscript|data):/iu;

export function parseResumeDocument(input: string) {
  const markdown = input.replace(/\r\n?/g, "\n").trimEnd() + "\n";
  if (markdown.length > maxResumeMarkdown || !markdown.startsWith(resumeHeader)) throw new Error("invalid_resume_document");
  const body = markdown.slice(resumeHeader.length);
  // Use the portable Markdown subset supported by the original compiler.
  if (forbidden.test(body) || email.test(body) || phone.test(body) || /^\s{0,3}\[[^\]\n]+\]:/m.test(body)) {
    throw new Error("invalid_resume_document");
  }
  const headers = [...body.matchAll(/^## Summary[ \t]*\n/gm)];
  if (headers.length !== 1) throw new Error("invalid_resume_summary");
  const start = headers[0].index + headers[0][0].length;
  const remaining = body.slice(start);
  const nextHeading = remaining.search(/^## /m);
  const summary = (nextHeading === -1 ? remaining : remaining.slice(0, nextHeading)).trim();
  if (!summary || summary.length > 2_000 || /\n#/.test(summary)) throw new Error("invalid_resume_summary");
  return { markdown, summary };
}

export function replaceDocumentSummary(document: string, summary: string) {
  const existing = parseResumeDocument(document).markdown;
  const heading = /^## Summary[ \t]*\n/m.exec(existing)!;
  const headerEnd = heading.index + heading[0].length;
  const remaining = existing.slice(headerEnd);
  const nextHeading = remaining.search(/^## /m);
  return parseResumeDocument(existing.slice(0, headerEnd) + "\n" + summary.trim() + "\n\n" +
    (nextHeading === -1 ? "" : remaining.slice(nextHeading)));
}
