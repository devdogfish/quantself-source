"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, Text, VisuallyHidden } from "@chakra-ui/react";
import { TodoNotesEditor } from "./todo-notes-editor";
import { useJarvisDraft } from "./jarvis-ui";
import styles from "./todo-notes-section.module.css";

import { taskUrlHref, normalizeTaskUrl } from "./task-urls";

const splitUrls = (value: string) => value ? value.split(/\r?\n/) : [""];
const serializeUrls = (rows: string[]) => rows.filter(row => row.trim()).map(normalizeTaskUrl).join("\n");

export function TodoNotesSection({ notes, urls, readOnly, onNotesCommit, onUrlsCommit }: {
  notes: string; urls: string; readOnly: boolean;
  onNotesCommit(before: string, after: string): void;
  onUrlsCommit(before: string, after: string): void;
}) {
  const [hasNotes, setHasNotes] = useState(!!notes.trim());
  useEffect(() => { setHasNotes(!!notes.trim()); }, [notes]);
  const [expanded, setExpanded] = useState(false);
  const [extrasExpanded, setExtrasExpanded] = useState(false);
  const extras = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [focusedUrl, setFocusedUrl] = useState<number | null>(null);
  const [focusNotes, setFocusNotes] = useState(false);
  const [rows, setRows] = useState(() => splitUrls(urls));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const baseline = useRef(urls);
  const composing = useRef(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);
  const id = useId();
  const commit = () => {
    if (readOnly || composing.current || !dirty) return;
    const after = serializeUrls(rows);
    try {
      if (after.length > 2000) throw new Error("URLs must be 2,000 characters or fewer.");
      if (after !== baseline.current) onUrlsCommit(baseline.current, after);
      baseline.current = after;
      setRows(current => current.map(row => row.trim() ? normalizeTaskUrl(row) : row));
      setDirty(false); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to queue URLs."); }
  };
  const latestCommit = useRef(commit); latestCommit.current = commit;
  useEffect(() => {
    if (dirty) return;
    if (baseline.current !== urls) { baseline.current = urls; setRows(splitUrls(urls)); }
  }, [urls]); // Keep local rows while publication is delayed or a newer draft exists.
  useEffect(() => {
    if (!dirty || readOnly) return;
    const timer = setTimeout(() => latestCommit.current(), 3000);
    return () => clearTimeout(timer);
  }, [rows, dirty, readOnly]);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    inputs.current[pendingFocus.current]?.focus(); pendingFocus.current = null;
  }, [rows, expanded, extrasExpanded]);
  useJarvisDraft(dirty);
  function update(next: string[]) { setRows(next); setDirty(true); setError(""); }
  const hasUrls = rows.some(row => row.trim());
  const collapse = useRef(() => {});
  collapse.current = () => {
    const section = root.current;
    if (!section || composing.current || dirty || error || hasUrls) return;
    if (section.querySelector('[data-inline-dirty="true"]')) return;
    if (extras.current?.contains(section.ownerDocument.activeElement)) return;
    setExtrasExpanded(false);
    if (rows.length > 1) setRows([""]);
    if (section.contains(section.ownerDocument.activeElement)) return;
    setExpanded(false); setFocusNotes(false); setFocusedUrl(null);
  };
  return <div ref={root} className={styles.root} onBlur={() => { queueMicrotask(() => collapse.current()); }}>
    {!expanded && !hasNotes && !hasUrls ? <button type="button" className={styles.expand} aria-expanded="false" aria-controls={id} disabled={readOnly} onClick={() => { setExpanded(true); setExtrasExpanded(true); setFocusNotes(true); }}>Add Notes, URL, or Attachments</button> : <section id={id} aria-label="Notes, URLs, and attachments" className={styles.expanded}>
      <TodoNotesEditor value={notes} readOnly={readOnly} autoFocus={focusNotes} placeholder="Add Notes" onCommit={(before, after) => { onNotesCommit(before, after); setExpanded(true); setHasNotes(!!after.trim()); }} />
      {!extrasExpanded && !hasUrls ? <button type="button" className={styles.expand} aria-expanded="false" aria-controls={`${id}-extras`} disabled={readOnly} onClick={() => { pendingFocus.current = 0; setExtrasExpanded(true); }}>Add URL or Attachments</button> : <div ref={extras} id={`${id}-extras`} className={styles.expanded}>
      <div className={styles.urls}>
        {rows.map((value, index) => {
          const href = taskUrlHref(value);
          const showValue = !!value.trim() && focusedUrl !== index;
          const invalidWhileEditing = focusedUrl === index && !!value.trim() && !href;
          return <div className={styles.urlEntry} key={index}><div className={styles.urlRow} onClick={event => { if (event.target === event.currentTarget) inputs.current[index]?.focus(); }}>
            <input ref={element => { inputs.current[index] = element; }} className={`${styles.input} ${showValue ? styles.displayInput : ""}`} type="text" data-inline-dirty={dirty} aria-label={index ? `URL ${index + 1}` : "URL"} placeholder="Add URL" value={value} readOnly={readOnly} aria-invalid={invalidWhileEditing || undefined} aria-describedby={`${id}-edit-url`} onFocus={() => setFocusedUrl(index)} onChange={event => update(rows.map((row, i) => i === index ? event.target.value : row))} onBlur={() => { commit(); setFocusedUrl(current => current === index ? null : current); }}
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; setRows(current => [...current]); }}
              onKeyDown={event => {
                if (readOnly || composing.current || event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && href) { event.preventDefault(); event.stopPropagation(); window.open(href, "_blank", "noopener,noreferrer"); return; }
                if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); pendingFocus.current = index + 1; update([...rows.slice(0, index), normalizeTaskUrl(value), "", ...rows.slice(index + 1)]); }
                if (event.key === "Backspace" && !value && rows.length > 1) { event.preventDefault(); pendingFocus.current = Math.max(0, index - 1); update(rows.filter((_, i) => i !== index)); }
                if (event.key === "Escape" && dirty) { event.preventDefault(); event.stopPropagation(); setRows(splitUrls(urls)); baseline.current = urls; setDirty(false); setError(""); }
              }} />
            {showValue && (href
              ? <a href={href} target="_blank" rel="noopener noreferrer" tabIndex={-1} className={styles.link}>{value}</a>
              : <span className={styles.text} onClick={() => inputs.current[index]?.focus()}>{value}</span>)}
          </div></div>;
        })}
      </div>
      <Button type="button" variant="ghost" aria-disabled="true" disabled={readOnly} className={styles.attachment} aria-describedby={`${id}-attachment`}>Add Attachment…</Button>
      <VisuallyHidden id={`${id}-edit-url`}>Tab to edit URL. Command or Control Enter opens a valid link.</VisuallyHidden>
      <VisuallyHidden id={`${id}-attachment`}>Attachments are not available yet.</VisuallyHidden>
      {error && <Text role="alert" fontSize="xs" color="fg.error">{error}</Text>}
      </div>}
    </section>}
  </div>;
}
