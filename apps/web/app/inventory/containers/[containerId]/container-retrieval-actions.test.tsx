import { createTestDom } from "@/components/shared/test-dom";
import { describe, expect, mock, test } from "bun:test";
import { act } from "react";

const routerCalls = {
  refresh: 0,
};

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: () => {},
  usePathname: () => "/inventory/browse",
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {
      routerCalls.refresh += 1;
    },
  }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("container retrieval actions", () => {
  const dom = createTestDom();
  test("downloads selected labels and atomically multi-selects items to move", async () => {
    const submissions: FormData[] = [];

    routerCalls.refresh = 0;
    const { ContainerRetrievalActions } =
      await import("./container-retrieval-actions");
    await dom.render(
      <ContainerRetrievalActions
        candidates={[
          {
            id: "item-projector",
            title: "Projector",
            where: "Media cabinet",
          },
          {
            id: "item-cable",
            title: "Power cable",
            where: "Unplaced",
          },
        ]}
        containerId="container-basement"
        labelUrl="/inventory/containers/container-basement/label"
        moveAction={async (_state, formData) => {
          submissions.push(formData);

          return { message: "Moved.", status: "success" };
        }}
      />,
    );

    await clickButton("Label PDF");

    expect(document.body.textContent).toContain(
      "Choose a printable container label.",
    );

    const labelLinks = Array.from(
      document.body.querySelectorAll<HTMLAnchorElement>("a[data-label-design]"),
    );

    expect(labelLinks).toHaveLength(2);
    expect(
      labelLinks.map((link) => [
        link.dataset.labelDesign,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      [
        "editorial",
        "/inventory/containers/container-basement/label?design=editorial&download=1",
      ],
      [
        "equipment-tag-aligned",
        "/inventory/containers/container-basement/label?design=equipment-tag-aligned&download=1",
      ],
    ]);

    await clickButton("Done");
    expect(
      document.body.querySelector(
        "[data-scope=dialog][data-part=content][data-state=open]",
      ),
    ).toBeNull();

    await clickButton("Move items here");

    expect(document.body.textContent).toContain(
      "The entire move succeeds or nothing changes.",
    );

    const checkboxes = Array.from(
      document.body.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    );

    expect(checkboxes).toHaveLength(2);

    await setChecked(checkboxes[0]!, true);
    await setChecked(checkboxes[1]!, true);

    expect(findButton("Move 2 items")?.disabled).toBe(false);

    await clickButton("Move 2 items");

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.get("containerId")).toBe("container-basement");
    expect(submissions[0]?.getAll("itemIds")).toEqual([
      "item-projector",
      "item-cable",
    ]);
    expect(routerCalls.refresh).toBe(1);
    expect(
      document.body.querySelector(
        "[data-scope=dialog][data-part=content][data-state=open]",
      ),
    ).toBeNull();
  });

  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === text);
  }

  async function clickButton(text: string) {
    const button = findButton(text);

    if (!button) {
      throw new Error(`Missing ${text} button`);
    }

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  async function setChecked(input: HTMLInputElement, checked: boolean) {
    await act(async () => {
      if (input.checked !== checked) {
        input.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
});
