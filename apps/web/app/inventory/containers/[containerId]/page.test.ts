import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("container detail page", () => {
  test("loads every item by exact container ID in the fullscreen scene", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(source).toContain("getInventoryContainerContents(containerId)");
    expect(source).toContain("getInventoryContainer(containerId)");
    expect(source).toContain("<ContainerVisual");
    expect(source).toContain("layoutSeed={crypto.randomUUID()}");
    expect(source).toContain("linkTitle={false}");
    expect(source).toContain('mode="scroll"');
    expect(source).toContain('as="main" {...containerPage}');
    expect(source).toContain("const items = contents.items;");
    expect(source).not.toContain("<InventoryShellCard");
  });

  test("orders Containers, Edit, Label PDF, then Move items", () => {
    const pageSource = readFileSync(
      new URL("./page.tsx", import.meta.url),
      "utf8",
    );
    const actionsSource = readFileSync(
      new URL("./container-retrieval-actions.tsx", import.meta.url),
      "utf8",
    );
    const editSource = readFileSync(
      new URL("./container-detail-edit.tsx", import.meta.url),
      "utf8",
    );
    const formSource = readFileSync(
      new URL("../container-form-dialog.tsx", import.meta.url),
      "utf8",
    );

    expect(pageSource.indexOf("Containers")).toBeLessThan(
      pageSource.indexOf("<ContainerDetailEdit"),
    );
    expect(actionsSource.indexOf("{children}")).toBeLessThan(
      actionsSource.indexOf("Label PDF"),
    );
    expect(actionsSource.indexOf("Label PDF")).toBeLessThan(
      actionsSource.indexOf("Move items here"),
    );
    expect(editSource).toContain("<PencilIcon />");
    expect(editSource).toContain("Edit");
    expect(pageSource).toContain("deleteInventoryContainerAction");
    expect(formSource).toContain("Delete container");
    expect(pageSource).toContain('wrap="wrap" align="center" justify="end"');
    expect(actionsSource.match(/\.\.\.detailAction/g)).toHaveLength(2);
    expect(actionsSource).toContain("<ArrowRightIcon />");
    expect(actionsSource).not.toContain("MoveRightIcon");
  });
});
