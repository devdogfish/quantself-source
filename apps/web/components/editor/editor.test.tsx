import { expect, test } from "bun:test";
import { createTestDom } from "../shared/test-dom";

const dom = createTestDom();

test("Lexical formatting renders without utility CSS and toolbar buttons stay keyboard accessible", async () => {
  // Use Lexical’s CJS entry to avoid Bun’s ESM cycle initialization error.
  const { $createParagraphNode, $createTextNode, $getRoot, createEditor } =
    require("lexical") as typeof import("lexical");
  const { $createHeadingNode, HeadingNode } =
    require("@lexical/rich-text") as typeof import("@lexical/rich-text");
  const { Toolbar } = await import("./plugins/toolbar/toolbar-plugin");
  const { editorTheme } = await import("./theme");
  let clicks = 0;
  await dom.render(
    <>
      <Toolbar aria-label="Formatting">
        <button onClick={() => clicks++}>Bold</button>
      </Toolbar>
      <div data-editor />
    </>,
  );
  const style = document.createElement("style");
  style.textContent = await Bun.file(
    new URL("./theme.css", import.meta.url),
  ).text();
  document.body.append(style);
  const root = dom.container.querySelector<HTMLElement>("[data-editor]")!;
  const editor = createEditor({
    namespace: "shared-editor-test",
    theme: editorTheme,
    nodes: [HeadingNode],
    onError(error) {
      throw error;
    },
  });
  editor.setRootElement(root);
  try {
    editor.update(
      () => {
        $getRoot().append(
          $createHeadingNode("h2").append($createTextNode("Heading")),
          $createParagraphNode().append(
            $createTextNode("Bold text").toggleFormat("bold"),
            $createTextNode("Inline code").toggleFormat("code"),
          ),
        );
      },
      { discrete: true },
    );
    expect(root.textContent).toBe("HeadingBold textInline code");
    expect(getComputedStyle(root.querySelector("h2")!).fontSize).toBe("30px");
    const bold = [...root.querySelectorAll("span, strong")].find(
      (el) => el.textContent === "Bold text",
    )!;
    expect(getComputedStyle(bold).fontWeight).toBe("700");
    const code = root.querySelector("code")!;
    expect(code).not.toBeNull();
    expect(getComputedStyle(code).display).not.toBe("block");
    const button = dom.container.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    expect(document.activeElement).toBe(button);
    await dom.click(button);
    expect(clicks).toBe(1);
    expect(dom.container.querySelector('[role="toolbar"]')).not.toBeNull();
  } finally {
    editor.setRootElement(null);
    style.remove();
  }
});
