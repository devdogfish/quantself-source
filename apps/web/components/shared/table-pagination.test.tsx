import { expect, mock, test } from "bun:test";
import { createTestDom } from "./test-dom";

const dom = createTestDom();
const q = (s: string) => dom.container.querySelector(s) as HTMLElement | null;
const pageButton = (n: number) => [...dom.container.querySelectorAll("button")].find((b) => b.textContent === String(n))!;

test("prev, next and page items change the page", async () => {
  const { TablePagination } = await import("./table-pagination");
  const onPage = mock<(p: number) => void>(() => {});
  await dom.render(<TablePagination count={50} pageSize={10} page={2} onPageChange={onPage} />);
  await dom.click(q('[aria-label="Previous page"]')!);
  expect(onPage).toHaveBeenLastCalledWith(1);
  await dom.click(q('[aria-label="Next page"]')!);
  expect(onPage).toHaveBeenLastCalledWith(3);
  await dom.click(pageButton(4));
  expect(onPage).toHaveBeenLastCalledWith(4);
});

test("jump-to-page only accepts numbers within 1..total", async () => {
  const { TablePagination } = await import("./table-pagination");
  const onPage = mock<(p: number) => void>(() => {});
  await dom.render(<TablePagination count={200} pageSize={10} page={1} onPageChange={onPage} />);
  await dom.click(q('[aria-label="Go to page"]')!);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Page number"]')!;
  const go = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Go")!;

  await dom.type(input, "99");
  expect(go().disabled).toBe(true);
  await dom.type(input, "0");
  expect(go().disabled).toBe(true);
  await dom.type(input, "a7");
  expect(input.value).toBe("7");
  expect(go().disabled).toBe(false);
  await dom.type(input, "20");
  await dom.click(go());
  expect(onPage).toHaveBeenLastCalledWith(20);
});
