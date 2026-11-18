import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  jest,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const replaceCalls: Array<{
  href: string;
  options: { scroll: boolean };
}> = [];
let currentSearchParams = new URLSearchParams();

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: () => {},
  usePathname: () => "/inventory",
  useRouter: () => ({
    push: () => {},
    replace: (href: string, options: { scroll: boolean }) => {
      replaceCalls.push({ href, options });
    },
    refresh: () => {},
  }),
  useSearchParams: () => currentSearchParams,
}));

let InventorySearchForm: typeof import("./inventory-search-form").InventorySearchForm;

describe("inventory search form", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ InventorySearchForm } = await import("./inventory-search-form"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
    currentSearchParams = new URLSearchParams("view=compact");
    replaceCalls.length = 0;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    cleanupGlobals?.();
    cleanupGlobals = null;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => {
    mock.restore();
  });

  test("searches through the URL 200ms after typing", async () => {
    await renderSearch();
    jest.useFakeTimers();
    await typeSearch("passport pouch");
    await act(async () => {
      jest.advanceTimersByTime(199);
    });
    expect(replaceCalls).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    jest.useRealTimers();
    expect(replaceCalls).toEqual([
      {
        href: "/inventory?view=compact&q=passport+pouch",
        options: { scroll: false },
      },
    ]);
  });

  test("submits immediately and cancels the debounced search", async () => {
    await renderSearch();
    await typeSearch("charger");

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Missing inventory search form");
    }

    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(replaceCalls).toEqual([
      {
        href: "/inventory?view=compact&q=charger",
        options: { scroll: false },
      },
    ]);

    await act(async () => {
      await wait(220);
    });
    expect(replaceCalls).toHaveLength(1);
  });

  test("removes q after the search is cleared", async () => {
    currentSearchParams = new URLSearchParams("view=compact&q=passport+pouch");
    await renderSearch("passport pouch");
    await typeSearch("");

    await act(async () => {
      await wait(220);
    });
    expect(replaceCalls[0]?.href).toBe("/inventory?view=compact");
  });

  async function renderSearch(query = "") {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventorySearchForm query={query} />
        </ChakraTestWrapper>,
      );
    });
  }

  async function typeSearch(value: string) {
    const input = container.querySelector<HTMLInputElement>('input[name="q"]');
    if (!input) {
      throw new Error("Missing inventory search input");
    }

    await act(async () => {
      input.value = value;
      reactInputProps(input).onChange({
        currentTarget: input,
        target: input,
      });
    });
  }
});

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    HTMLElement: globalThis.HTMLElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    navigator: window.navigator,
    Node: window.Node,
    window,
  });

  return () => {
    Object.assign(globalThis, previous);
  };
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}

function reactInputProps(input: HTMLInputElement): {
  onChange: (event: {
    currentTarget: HTMLInputElement;
    target: HTMLInputElement;
  }) => void;
} {
  return reactProps(input) as {
    onChange: (event: {
      currentTarget: HTMLInputElement;
      target: HTMLInputElement;
    }) => void;
  };
}

function reactProps(element: Element): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );

  if (!propsKey) {
    throw new Error("Missing React props");
  }

  return (element as unknown as Record<string, Record<string, unknown>>)[
    propsKey
  ]!;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
