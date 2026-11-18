/** Editable task prose, excluding provenance and managed metadata. */
export function taskDescriptionSpan(body: string | null) {
  const raw = body ?? "";
  const prefix = /^Source: client message\nCaptured: [^\n]*\nCommand ID: [^\n]*\n<!-- quantself:command [a-f0-9]+ -->\n\n/.exec(raw)?.[0] ?? "";
  return { body: raw, offset: prefix.length, text: raw.slice(prefix.length).split("<!--")[0] };
}
export function readTaskDescription(body: string | null) {
  return taskDescriptionSpan(body).text.trimEnd();
}
