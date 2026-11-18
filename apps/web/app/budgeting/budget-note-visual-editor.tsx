"use client";

import { chakra, Button, Flex } from "@chakra-ui/react";

import { useEffect, useRef } from "react";
import { CodeExtension } from "@lexical/code-core";
import { HistoryExtension } from "@lexical/history";
import { LinkExtension } from "@lexical/link";
import {
  CheckListExtension,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  TRANSFORMERS,
} from "@lexical/markdown";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextExtension } from "@lexical/rich-text";
import {
  $createParagraphNode,
  $getRoot,
  $setSelection,
  defineExtension,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import { Bold, Italic, List, ListChecks, Redo2, Undo2 } from "lucide-react";

const transformers = [CHECK_LIST, ...TRANSFORMERS];
const sourceSync = "budget-note-source";
const editorExtension = defineExtension({
  name: "BudgetNote",
  namespace: "BudgetNote",
  theme: {
    text: {
      bold: "budget-bold",
      italic: "budget-italic",
      code: "budget-code",
      strikethrough: "budget-strike",
      underline: "budget-underline",
      underlineStrikethrough: "budget-underline-strike",
    },
    code: "budget-code-block",
    list: {
      listitemChecked: "budget-checked",
      listitemUnchecked: "budget-unchecked",
    },
  },
  dependencies: [
    RichTextExtension,
    HistoryExtension,
    CheckListExtension,
    LinkExtension,
    CodeExtension,
  ],
});

const placeholder = "Write down what changed in your budget…";

function MarkdownBridge({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const source = useRef<string | null>(null);

  useEffect(() => {
    if (source.current === value) return;
    source.current = value;
    editor.update(
      () => {
        $convertFromMarkdownString(value, transformers, undefined, true);
        const root = $getRoot();
        if (root.isEmpty()) root.append($createParagraphNode());
        $setSelection(null);
      },
      { tag: sourceSync },
    );
  }, [editor, value]);

  useEffect(
    () =>
      editor.registerUpdateListener(
        ({ editorState, tags, dirtyElements, dirtyLeaves }) => {
          if (
            tags.has(sourceSync) ||
            (!dirtyElements.size && !dirtyLeaves.size)
          )
            return;
          const markdown = editorState.read(() =>
            $convertToMarkdownString(transformers, undefined, true),
          );
          source.current = markdown;
          onChange(markdown);
        },
      ),
    [editor, onChange],
  );

  return null;
}

function FormattingToolbar() {
  const [editor] = useLexicalComposerContext();
  const actions = [
    {
      label: "Undo",
      icon: Undo2,
      run: () => editor.dispatchCommand(UNDO_COMMAND, undefined),
    },
    {
      label: "Redo",
      icon: Redo2,
      run: () => editor.dispatchCommand(REDO_COMMAND, undefined),
    },
    {
      label: "Bold",
      icon: Bold,
      run: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold"),
    },
    {
      label: "Italic",
      icon: Italic,
      run: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic"),
    },
    {
      label: "Bulleted list",
      icon: List,
      run: () =>
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
    },
    {
      label: "Checklist",
      icon: ListChecks,
      run: () => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined),
    },
  ];

  return (
    <Flex
      role="toolbar"
      aria-label="Budget Note formatting"
      gap="1"
      p="2"
      borderBottomWidth="1px"
      overflowX="auto"
    >
      {actions.map(({ label, icon: Icon, run }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="sm"
          title={label}
          aria-label={label}
          onClick={run}
        >
          <Icon />
        </Button>
      ))}
    </Flex>
  );
}

export default function BudgetNoteVisualEditor(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <chakra.div
      overflow="hidden"
      borderRadius="lg"
      borderWidth="1px"
      css={{ _focusWithin: { borderColor: "border.emphasized" } }}
    >
      <LexicalExtensionComposer
        extension={editorExtension}
        contentEditable={null}
      >
        <FormattingToolbar />
        <chakra.div position="relative">
          <chakra.div
            css={{
              "& [contenteditable]": {
                minH: "64",
                px: "4",
                py: "3",
                fontSize: "sm",
                outline: "none",
                "& p": { mb: "2" },
                "& h1, & h2, & h3": { fontWeight: "semibold", my: "3" },
                "& ul": { listStyle: "disc", ps: "6" },
                "& ol": { listStyle: "decimal", ps: "6" },
                "& .budget-bold": { fontWeight: "bold" },
                "& .budget-italic": { fontStyle: "italic" },
                "& .budget-strike": { textDecoration: "line-through" },
                "& .budget-underline": { textDecoration: "underline" },
                "& .budget-underline-strike": {
                  textDecoration: "underline line-through",
                },
                "& a": {
                  color: "colorPalette.fg",
                  textDecoration: "underline",
                },
                "& blockquote": {
                  borderInlineStartWidth: "2px",
                  ps: "4",
                  color: "fg.muted",
                },
                "& .budget-code-block": {
                  fontFamily: "mono",
                  bg: "bg.muted",
                  whiteSpace: "pre",
                  overflowX: "auto",
                  p: "3",
                  rounded: "md",
                },
                "& .budget-code": { fontFamily: "mono", bg: "bg.muted" },
                "& .budget-checked, & .budget-unchecked": {
                  listStyle: "none",
                  cursor: "pointer",
                  position: "relative",
                  ps: "6",
                },
                "& .budget-checked::before": {
                  content: '"☑"',
                  position: "absolute",
                  insetInlineStart: "0",
                },
                "& .budget-unchecked::before": {
                  content: '"☐"',
                  position: "absolute",
                  insetInlineStart: "0",
                },
              },
            }}
          >
            <ContentEditable
              aria-label="Budget Note visual editor"
              aria-placeholder={placeholder}
              placeholder={
                <chakra.div
                  pointerEvents="none"
                  position="absolute"
                  left="4"
                  top="3"
                  fontSize="sm"
                  color="fg.muted"
                >
                  {placeholder}
                </chakra.div>
              }
            />
          </chakra.div>
        </chakra.div>
        <MarkdownShortcutPlugin transformers={transformers} />
        <MarkdownBridge {...props} />
      </LexicalExtensionComposer>
    </chakra.div>
  );
}
