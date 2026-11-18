import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryItemCollapsibleText } from "./inventory-item-collapsible-text";

describe("InventoryItemCollapsibleText", () => {
  test("leaves concise evidence fully visible", () => {
    const html = renderToStaticMarkup(
      <ChakraTestWrapper>
        <InventoryItemCollapsibleText text="Short OCR evidence." />
      </ChakraTestWrapper>,
    );

    expect(html).toContain("Short OCR evidence.");
    expect(html).not.toContain("Read more");
  });

  test("collapses long evidence and toggles it accessibly", async () => {
    const window = new Window();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.assign(globalThis, {
      document: window.document,
      window,
    });
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const root = createRoot(host as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryItemCollapsibleText
              label="OCR evidence"
              text={"OCR ".repeat(80)}
            />
          </ChakraTestWrapper>,
        );
      });
      const button = host.querySelector(
        "button",
      ) as unknown as HTMLButtonElement | null;
      const text = host.querySelector(
        "p",
      ) as unknown as HTMLParagraphElement | null;

      if (!button || !text) {
        throw new Error("Expected collapsible evidence controls.");
      }

      expect(button.textContent).toBe("Read more");
      expect(button.getAttribute("aria-label")).toBe("Read more OCR evidence");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).toBe(text.id);
      const clampedClass = text.className;

      button.focus();
      expect(document.activeElement).toBe(button);

      await act(async () => button.click());

      expect(button.textContent).toBe("Read less");
      expect(button.getAttribute("aria-label")).toBe("Read less OCR evidence");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(text.className).not.toBe(clampedClass);
      expect(document.activeElement).toBe(button);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Object.assign(globalThis, {
        document: previousDocument,
        window: previousWindow,
      });
      delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      window.close();
    }
  });
});
