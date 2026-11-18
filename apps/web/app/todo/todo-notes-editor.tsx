"use client";
import { Text } from "@chakra-ui/react";

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor, type Extensions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { ListKeymap, TaskItem, TaskList } from "@tiptap/extension-list";
import { useJarvisDraft } from "./jarvis-ui";
import styles from "./todo-notes-editor.module.css";

// Preserve existing Markdown image references without fetching external media on open.
const ImageReference = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const source = String(HTMLAttributes.src ?? "");
    const label = `Image: ${String(HTMLAttributes.alt || source)}`;
    return /^(https?:)/i.test(source)
      ? ["a", { href: source, target: "_blank", rel: "noopener noreferrer" }, label]
      : ["span", {}, label];
  },
});

// Keep Tab outside lists available for focus navigation, including after a list.
const NotesListKeymap = ListKeymap.extend({
  addKeyboardShortcuts() {
    return { ...this.parent?.(), Tab: () => false };
  },
});

export function notesExtensions(placeholder = "No notes") {
  return [
    StarterKit.configure({
      // Markdown has no underline syntax; all available formatting round-trips.
      underline: false,
      // Do not insert a paragraph merely because a saved note ends with a list/table.
      trailingNode: false,
      listKeymap: false,
      codeBlock: { enableTabIndentation: true },
      link: {
        openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https",
        isAllowedUri: (url, context) => context.defaultValidate(url) && /^(https?:|mailto:)/i.test(url),
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
    }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    Placeholder.configure({ placeholder, showOnlyWhenEditable: false }),
    TableKit, ImageReference,
    NotesListKeymap, TaskList, TaskItem.configure({ nested: true }),
  ];
}

/** Tiptap owns formatting/selection; the existing task queue owns persistence and Undo. */
export function TodoNotesEditor({ value, readOnly, onCommit, placeholder = "No notes", autoFocus = false, label = "Notes", extensions = [], markdownEditing = false }: {
  value: string; readOnly: boolean; placeholder?: string; autoFocus?: boolean; label?: string;
  extensions?: Extensions;
  markdownEditing?: boolean;
  onCommit(before: string, after: string): void;
}) {
  const baseline = useRef(value);
  const normalizedBaseline = useRef<string | null>(null);
  const initialized = useRef(false);
  const draft = useRef<string | null>(null);
  const composing = useRef(false);
  const [change, setChange] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const sourceAtEntry = useRef("");
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const focusAfterToggle = useRef(false);
  const current = useRef({ value, readOnly, onCommit }); current.current = { value, readOnly, onCommit };
  const commit = useRef<() => void>(() => {});
  const discard = useRef<(editor: Editor) => void>(() => {});
  const updateDraft = (markdown: string | null) => {
    draft.current = markdown;
    setDirty(markdown !== null);
    setError("");
    setChange(version => version + 1);
  };

  const editor = useEditor({
    extensions: [...notesExtensions(placeholder), ...extensions],
    autofocus: autoFocus ? "end" : false, content: value, contentType: "markdown", editable: !readOnly,
    immediatelyRender: false, shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", class: styles.content },
      // Parse plain-text Markdown with the library; keep rich HTML and code pastes native.
      handlePaste: (view, event) => {
        const editor = (view.dom as HTMLElement & { editor: Editor }).editor;
        const clipboard = event.clipboardData;
        if (!editor || current.current.readOnly || editor.isActive("codeBlock") || !clipboard || clipboard.getData("text/html")) return false;
        const text = clipboard.getData("text/plain");
        if (!text) return false;
        return editor.commands.insertContent(text, { contentType: "markdown" });
      },
      handleDOMEvents: {
        compositionstart: () => { composing.current = true; return false; },
        compositionend: () => { composing.current = false; setChange(version => version + 1); return false; },
        click: (_view, event) => {
          const link = (event.target as HTMLElement | null)?.closest("a");
          if (!link) return false;
          event.preventDefault();
          // In editing mode a normal click places the caret inside the link.
          if (markdownEditing && !current.current.readOnly && !event.metaKey && !event.ctrlKey) return false;
          if (/^(https?:|mailto:)/i.test(link.href)) window.open(link.href, "_blank", "noopener,noreferrer");
          return true;
        },
        // Editor shortcuts take precedence over application shortcuts. Let
        // ProseMirror's keymaps and browser defaults handle the event locally.
        keydown: (_view, event) => {
          if (event.metaKey || event.ctrlKey) event.stopPropagation();
          return false;
        },
      },
      handleKeyDown: (view, event) => {
        // Do not let downstream list/table keymaps change structure during IME input.
        if (event.isComposing || composing.current || view.composing) return event.key === "Tab";
        if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const editor = (view.dom as HTMLElement & { editor: Editor }).editor;
          if (!editor || current.current.readOnly || !editor.isEditable) return false;
          // Tables and code blocks retain their library-owned Tab behavior.
          if (editor.isActive("table") || editor.isActive("codeBlock")) return false;
          const { $from } = view.state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            const name = $from.node(depth).type.name;
            if (name !== "listItem" && name !== "taskItem") continue;
            if (event.shiftKey) editor.commands.liftListItem(name);
            else editor.commands.sinkListItem(name);
            // An item with no previous sibling cannot nest; keep its focus in place.
            event.preventDefault();
            return true;
          }
        }
        if (event.key === "Escape" && draft.current !== null) {
          event.preventDefault(); event.stopPropagation();
          discard.current((view.dom as HTMLElement & { editor: Editor }).editor); return true;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault(); commit.current(); view.dom.blur(); return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => { normalizedBaseline.current = editor.getMarkdown(); initialized.current = true; },
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      if (!initialized.current) { normalizedBaseline.current = markdown; return; }
      updateDraft(markdown === normalizedBaseline.current ? null : markdown);
    },
    onBlur: () => commit.current(),
  });

  commit.current = () => {
    if (current.current.readOnly || composing.current || draft.current === null) return;
    try {
      const next = draft.current;
      if (next.length > 50000) throw new Error("Notes must be 50,000 characters or fewer.");
      current.current.onCommit(baseline.current, next);
      baseline.current = next; normalizedBaseline.current = next; draft.current = null;
      setDirty(false); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to queue notes."); }
  };
  discard.current = editor => {
    const source = current.current.value;
    editor.commands.setContent(source, { contentType: "markdown", emitUpdate: false });
    baseline.current = source; normalizedBaseline.current = editor.getMarkdown(); draft.current = null;
    setDirty(false); setError("");
  };

  const showingSource = source !== null;
  const toggleSource = () => {
    if (!editor) return;
    focusAfterToggle.current = true;
    if (source === null) {
      sourceAtEntry.current = draft.current ?? baseline.current;
      setSource(sourceAtEntry.current);
    } else {
      if (source !== sourceAtEntry.current) {
        editor.commands.setContent(source, { contentType: "markdown", emitUpdate: false });
        commit.current();
        if (draft.current === null) normalizedBaseline.current = editor.getMarkdown();
      }
      setSource(null);
    }
  };

  useEffect(() => {
    if (!editor || !focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    if (showingSource) sourceInput.current?.focus();
    else editor.view.focus();
  }, [editor, showingSource]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly, false);
    editor.view.dom.setAttribute("aria-readonly", String(readOnly));
  }, [editor, readOnly]);
  useEffect(() => { editor?.view.dom.setAttribute("data-inline-dirty", String(dirty)); }, [editor, dirty]);
  useEffect(() => {
    if (!editor || draft.current !== null) return;
    // Acknowledgements must not reconstruct the document or move the cursor.
    if (baseline.current !== value) {
      editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
      baseline.current = value; normalizedBaseline.current = editor.getMarkdown();
      sourceAtEntry.current = value;
      setSource(previous => previous === null || previous.trim() === value.trim() ? previous : value);
    } else if (normalizedBaseline.current === null) normalizedBaseline.current = editor.getMarkdown();
    // Clearing a queued draft is not a source update. The queue may publish its
    // optimistic value after this render; reapplying the unchanged prop loses it.
  }, [editor, value]);
  useEffect(() => {
    if (!dirty || readOnly) return;
    const timeout = setTimeout(() => commit.current(), 3000);
    return () => clearTimeout(timeout);
  }, [change, dirty, readOnly]);
  useJarvisDraft(dirty);

  return <div className={styles.root} data-inline-dirty={dirty} onKeyDownCapture={markdownEditing ? event => {
    if (readOnly || composing.current || event.nativeEvent.isComposing || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
    if (event.code !== "Period" && event.key !== ">" && event.key !== ".") return;
    event.preventDefault();
    event.stopPropagation();
    toggleSource();
  } : undefined}>
    {!editor && <Text fontSize="sm" color="fg.muted">{value || placeholder}</Text>}
    <EditorContent editor={editor} hidden={showingSource} />
    {showingSource && <textarea className={styles.source} ref={sourceInput} aria-label={`${label} Markdown source`}
      aria-keyshortcuts="Meta+Shift+. Control+Shift+." value={source} readOnly={readOnly} rows={8} spellCheck={false}
      onChange={event => {
        const markdown = event.currentTarget.value;
        setSource(markdown);
        updateDraft(markdown === baseline.current ? null : markdown);
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; setChange(version => version + 1); }}
      onBlur={() => commit.current()}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing) return;
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.blur();
        } else if (event.key === "Escape" && draft.current !== null && editor) {
          event.preventDefault();
          event.stopPropagation();
          discard.current(editor);
          sourceAtEntry.current = current.current.value;
          setSource(sourceAtEntry.current);
        }
      }} />}
    {error && <Text role="alert" pt="1" fontSize="xs" color="fg.error">{error}</Text>}
  </div>;
}
