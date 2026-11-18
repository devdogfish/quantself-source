"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

/** Select editable text only when native Tab navigation enters this surface. */
export function bindTabSelectAll(surface: HTMLElement) {
  const document = surface.ownerDocument;
  let tabbing = false;
  const keydown = (event: KeyboardEvent) => { tabbing = event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey; };
  const reset = () => { tabbing = false; };
  const focus = (event: FocusEvent) => {
    const target = event.target;
    if (!tabbing || !(target instanceof HTMLElement) || !surface.contains(target)) return;
    // A nested portal can bubble through React but is outside this DOM surface.
    tabbing = false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target.readOnly || target.disabled) return;
      if (target instanceof HTMLTextAreaElement || ["text", "search", "email", "tel", "url", "password", "number"].includes(target.type)) target.select();
      return;
    }
    if (target.getAttribute("contenteditable") !== "true") return;
    // Use the editor's document selection, never a page-level select-all command.
    const editor = (target as HTMLElement & { editor?: Editor }).editor;
    if (editor?.isEditable) editor.commands.selectAll();
  };
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("keyup", reset, true);
  document.addEventListener("pointerdown", reset, true);
  document.addEventListener("mousedown", reset, true);
  surface.addEventListener("focusin", focus);
  return () => {
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("keyup", reset, true);
    document.removeEventListener("pointerdown", reset, true);
    document.removeEventListener("mousedown", reset, true);
    surface.removeEventListener("focusin", focus);
  };
}

export function useTabSelectAll() {
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback((surface: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = surface ? bindTabSelectAll(surface) : undefined;
  }, []);
}
