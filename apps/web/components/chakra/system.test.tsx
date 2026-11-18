import { ChakraProvider } from "@chakra-ui/react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { system } from "./system";

test("server-rendered Chakra layers preserve the shared brand token", () => {
  const html = renderToStaticMarkup(
    <ChakraProvider value={system}>
      <button>Continue</button>
    </ChakraProvider>,
  );
  const css = [...html.matchAll(/<style data-emotion="css-global[^"]*">([^<]*)<\/style>/g)]
    .map((match) => match[1])
    .join("\n");

  expect(css).toContain("@layer reset{");
  expect(css).toContain("--brand:#005daa");
  expect(css).toContain("--chakra-colors-brand-solid:var(--chakra-colors-brand-500)");
});
