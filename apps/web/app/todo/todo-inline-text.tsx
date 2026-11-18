"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Text, chakra } from "@chakra-ui/react";
import { useJarvisDraft } from "./jarvis-ui";
import styles from "./todo-detail.module.css";

/** Quiet autosave field: blur or 3s idle commits; Escape restores the current value. */
export function TodoInlineText({ value, label, placeholder, readOnly, onCommit, onSubmit, title = false }: {
  value: string; label: string; placeholder: string; readOnly: boolean;
  title?: boolean;
  onCommit(before: string, after: string): void;
  onSubmit?(): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const baseline = useRef(value);
  if (draft === null) baseline.current = value;
  const [error, setError] = useState("");
  const titleInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = titleInput.current;
    if (!element) return;
    element.style.height = "auto";
    if (element.scrollHeight) element.style.height = `${element.scrollHeight}px`;
  }, [draft, value]);
  function commit() {
    if (readOnly) return false;
    try {
      if (!readOnly && draft !== null && draft !== baseline.current) {
        onCommit(baseline.current, draft);
        baseline.current = draft;
      }
      setDraft(null);
      setError("");
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to queue this change."); return false; }
  }
  const latestCommit = useRef(commit); latestCommit.current = commit;
  useEffect(() => {
    if (draft === null || readOnly) return;
    const timer = setTimeout(() => latestCommit.current(), 3000);
    return () => clearTimeout(timer);
  }, [draft, readOnly]);
  useJarvisDraft(draft !== null && draft !== value);
  const shared = {
    "aria-label": label, placeholder, readOnly, value: draft ?? value,
    "data-inline-dirty": draft !== null,
    className: title ? `${styles.inlineText} ${styles.titleInput}` : styles.inlineText,
    onFocus: () => { if (draft === null) baseline.current = value; },
    "aria-invalid": !!error,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(title ? event.target.value.replace(/[\r\n]+/g, " ") : event.target.value); setError(""); },
    onBlur: () => { commit(); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape" && draft !== null) { event.preventDefault(); event.stopPropagation(); baseline.current = value; setDraft(null); }
      if (event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        if (commit()) { event.currentTarget.blur(); onSubmit?.(); }
      }
    },
  };
  return <>{title ? <chakra.textarea {...shared} ref={titleInput} rows={1} wrap="soft" maxLength={256} /> : <chakra.input {...shared} maxLength={2000} />}{error && <Text role="alert" pt="1" fontSize="xs" color="fg.error">{error}</Text>}</>;
}
