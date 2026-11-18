import { Fragment } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { AllSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Extension, InputRule, findParentNodeClosestToPos, getMarkRange, type Editor } from "@tiptap/react";

const brackets = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`" };

function webUrl(value: string) {
  const url = value.trim();
  if (!url || /[\s\\<>"\x00-\x1f\x7f]/.test(url)) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    // Keep the spelling of a supplied URL for exact résumé tracking matches.
    return candidate;
  } catch { return null; }
}

function editLink(editor: Editor) {
  const existing = editor.getAttributes("link").href ?? "";
  const url = window.prompt("Link URL", existing);
  if (url === null) return true;
  const chain = editor.chain().extendMarkRange("link");
  if (!url.trim()) chain.unsetLink().run();
  else {
    const href = webUrl(url);
    if (!href) return true;
    if (editor.state.selection.empty && !existing) {
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else chain.setLink({ href }).run();
  }
  return true;
}

function cycleChecklist(editor: Editor) {
  const { selection, schema } = editor.state;
  const { $from, $to } = selection;
  for (let depth = $from.depth; depth > 1; depth--) {
    const item = $from.node(depth);
    const list = $from.node(depth - 1);
    const task = item.type === schema.nodes.taskItem;
    if (!task && item.type !== schema.nodes.listItem) continue;
    if ($to.depth < depth || $to.before(depth) !== $from.before(depth)) return false;
    return editor.commands.command(({ tr }) => {
      const itemPos = $from.before(depth);
      if (task && !item.attrs.checked) {
        tr.setNodeAttribute(itemPos, "checked", true);
        return true;
      }

      // Split sibling items around the converted item. Keep its text, marks,
      // nested blocks and selection intact while changing the list type.
      const listPos = $from.before(depth - 1);
      const itemOffset = itemPos - listPos - 1;
      const before = list.content.cut(0, itemOffset);
      const after = list.content.cut(itemOffset + item.nodeSize);
      const targetItem = schema.nodes[task ? "listItem" : "taskItem"].createChecked(null, item.content);
      const targetList = schema.nodes[task ? "bulletList" : "taskList"].createChecked(null, targetItem);
      const remaining = list.type === schema.nodes.orderedList
        ? list.type.create({ ...list.attrs, start: list.attrs.start + before.childCount + 1 }, after)
        : list.copy(after);
      const replacement = Fragment.fromArray([
        ...(before.size ? [list.copy(before)] : []), targetList,
        ...(after.size ? [remaining] : []),
      ]);
      tr.replaceWith(listPos, listPos + list.nodeSize, replacement);
      const targetPos = listPos + (before.size ? before.size + 2 : 0);
      const offset = targetPos + 1 - itemPos;
      tr.setSelection(TextSelection.create(tr.doc, selection.anchor + offset, selection.head + offset));
      const end = targetPos + targetList.nodeSize;
      if (tr.doc.resolve(end).nodeAfter?.type === targetList.type && canJoin(tr.doc, end)) tr.join(end);
      if (tr.doc.resolve(targetPos).nodeBefore?.type === targetList.type && canJoin(tr.doc, targetPos)) tr.join(targetPos);
      return true;
    });
  }
  return editor.commands.toggleTaskList();
}

function arrangeBullet(editor: Editor, action: "up" | "down" | "duplicate") {
  const { selection } = editor.state;
  const { $from, to, anchor, head } = selection;
  const item = findParentNodeClosestToPos($from, node => node.type.name === "listItem" || node.type.name === "taskItem");
  if (!item || to >= item.pos + item.node.nodeSize) return false;
  const list = $from.node(item.depth - 1);
  const index = $from.index(item.depth - 1);
  const end = item.pos + item.node.nodeSize;
  return editor.commands.command(({ tr }) => {
    closeHistory(tr);
    let offset: number;
    if (action === "duplicate") {
      tr.insert(end, item.node);
      offset = item.node.nodeSize;
    } else {
      const sibling = list.maybeChild(index + (action === "up" ? -1 : 1));
      if (!sibling) return true;
      if (action === "up") {
        offset = -sibling.nodeSize;
        tr.replaceWith(item.pos + offset, end, [item.node, sibling]);
      } else {
        offset = sibling.nodeSize;
        tr.replaceWith(item.pos, end + offset, [sibling, item.node]);
      }
    }
    tr.setSelection(TextSelection.create(tr.doc, anchor + offset, head + offset));
    return true;
  });
}

function markdownSyntax(position: number, text: string, side: number) {
  return Decoration.widget(position, view => {
    const syntax = view.dom.ownerDocument.createElement("span");
    syntax.dataset.markdownLinkSyntax = "";
    syntax.setAttribute("aria-hidden", "true");
    syntax.textContent = text;
    return syntax;
  }, { key: text, side, marks: [] });
}

export const ResumeMarkdownShortcuts = Extension.create({
  name: "resumeMarkdownShortcuts",
  addKeyboardShortcuts() {
    const { editor } = this;
    return {
      "Mod-k": () => editLink(editor),
      "Mod-Shift-k": () => editLink(editor),
      "Mod-l": () => cycleChecklist(editor),
      "Mod-Shift-l": () => cycleChecklist(editor),
      "Alt-ArrowUp": () => arrangeBullet(editor, "up"),
      "Alt-ArrowDown": () => arrangeBullet(editor, "down"),
      "Alt-Shift-ArrowDown": () => arrangeBullet(editor, "duplicate"),
      ...Object.fromEntries(Object.entries(brackets).map(([open, close]) => [open, () => {
        const active = editor.state.selection;
        const selection = active instanceof AllSelection ? TextSelection.between(active.$from, active.$to) : active;
        if (!(selection instanceof TextSelection) || selection.empty) return false;
        const { from, to, anchor, head } = selection;
        return editor.commands.command(({ tr }) => {
          tr.insertText(close, to).insertText(open, from);
          tr.setSelection(TextSelection.create(tr.doc, anchor + 1, head + 1));
          return true;
        });
      }])),
    };
  },
  addProseMirrorPlugins() {
    const { editor } = this;
    return [new Plugin({ props: {
      decorations(state) {
        if (!editor.isEditable || !editor.isFocused || !(state.selection instanceof TextSelection)) return null;
        const { $head, from, to } = state.selection;
        const link = state.schema.marks.link;
        const mark = link.isInSet($head.nodeAfter?.marks ?? []);
        const range = mark && getMarkRange($head, link, mark.attrs);
        if (!range || from < range.from || to > range.to) return null;
        const title = mark.attrs.title ? ` "${mark.attrs.title}"` : "";
        return DecorationSet.create(state.doc, [
          markdownSyntax(range.from, "[", -1),
          Decoration.inline(range.from, range.to, { "data-markdown-link-label": "" }),
          markdownSyntax(range.to, `](${mark.attrs.href}${title})`, 1),
        ]);
      },
    } })];
  },
  addInputRules() {
    const { editor } = this;
    return [new InputRule({
      find(text) {
        if (!text.endsWith(")") || !text.includes("](")) return null;
        const token = editor.markdown?.instance.Lexer.lexInline(text).at(-1);
        if (token?.type !== "link" || !/^https?:\/\//i.test(token.href) || !webUrl(token.href)) return null;
        return { index: text.length - token.raw.length, text: token.raw };
      },
      handler({ range, match, commands }) {
        const inline = editor.markdown?.parse(match[0]).content?.[0]?.content;
        if (!inline?.length) return null;
        commands.insertContentAt(range, inline);
      },
    })];
  },
});
