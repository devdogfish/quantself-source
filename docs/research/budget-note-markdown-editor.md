# Budget Note Markdown editor

Researched 2026-11-08 against upstream documentation and the Quantself checkout.

## Selected editor

The Budget Note uses a Lexical visual editor with a Chakra toolbar, plus separate Markdown and Preview tabs. Opening the visual editor leaves the saved source intact. A visual edit exports Markdown through Lexical, which can normalize formatting. The Markdown tab edits the same string Codex receives. [Lexical Markdown](https://lexical.dev/docs/packages/lexical-markdown)

The [Budget Note](../../CONTEXT.md) is the Owner's freeform account of cash, spending plans and expected changes. Its source should preserve incomplete syntax, blank lines and formatting choices during editing. Keep proposed budget changes and approval in the surrounding workflow. The checkout defines the term and has an existing [Tiptap To-do Notes editor](../../apps/web/app/todo/todo-notes-editor.tsx).

## Comparison

| Editor | Shipped UI and Markdown behavior | Budget Note fit |
| --- | --- | --- |
| **UIW React MDEditor** | Styled, controlled textarea with toolbar, GFM preview, and source, preview or split modes. The Markdown string backs both edit and preview. Upstream documents an App Router integration and its React peer range includes React 19. [Documentation](https://github.com/uiwjs/react-md-editor#support-nextjs) · [Package manifest](https://github.com/uiwjs/react-md-editor/blob/master/core/package.json) | Best fit for direct typing and paste, with preview as a separate view. Adapt the palette, toolbar and narrow layout. |
| **MDXEditor** | Styled React rich-text editor with configurable toolbar and CodeMirror source mode. Source mode supports incomplete syntax and whitespace. Entering rich-text mode parses the source. The editor can normalize Markdown and needs plugins for constructs such as tables. App Router setup uses a client-only dynamic import. [Source mode](https://mdxeditor.dev/editor/docs/diff-source) · [React API](https://github.com/mdx-editor/editor/blob/main/src/MDXEditor.tsx) · [Error handling](https://mdxeditor.dev/editor/docs/error-handling) · [Next.js setup](https://mdxeditor.dev/editor/docs/getting-started) | Strong option if visual editing becomes a requirement alongside direct source editing. |
| **Milkdown Crepe** | Styled WYSIWYG editor with light/dark themes, React adapter and Markdown read/change APIs. The documented editor features center on rich-text editing. A whole-document source view would need separate UI. [Crepe guide](https://milkdown.dev/docs/guide/using-crepe) · [React integration](https://milkdown.dev/docs/recipes/react) · [Feature API](https://milkdown.dev/docs/api/crepe) | Good fit for inline visual editing. Adds editor lifecycle and source-view integration for this workflow. |
| **Existing Tiptap** | Already installed. The To-do component parses and serializes Markdown through its document model and tracks a normalized baseline. Tiptap's separate Simple Editor template ships rich-text controls and requires styling setup. Its Markdown extension is documented as beta. [To-do source](../../apps/web/app/todo/todo-notes-editor.tsx) · [Markdown docs](https://tiptap.dev/docs/editor/markdown) · [Simple Editor template](https://tiptap.dev/docs/ui-components/templates/simple-editor) | Reuse makes sense for another To-do-style editor. A source-first Budget Note still needs a distinct editing surface. |

## Integration checks

Preview uses React Markdown and skips HTML and image requests. The visual editor remains mounted across tab changes to preserve editing state.

### Verification

- Keep the source string as the input to both persistence and Codex. Verify paste and reload with GFM tables, task lists, code fences, incomplete Markdown, blank lines and non-ASCII text.
- Verify labeled keyboard focus, toolbar controls, Undo and mobile layout.
- Keep HTML and remote images from loading in budget previews. The existing To-do editor renders Markdown images as links to avoid automatic requests. [To-do image policy](../../apps/web/app/todo/todo-notes-editor.tsx)
- Scope the editor to the budget route. Check mount time and typing responsiveness with a long note. If saves run asynchronously, verify that delayed acknowledgements preserve subsequent edits. [Responsive interaction standard](../responsive-interaction.md)

Headless Chrome verified that the visual editor mounts without changing the saved Markdown and that a delayed save preserves subsequent edits. Bundle size remains unmeasured.
