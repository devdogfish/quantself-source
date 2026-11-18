import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  type AnchorHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { testContainerVisualPreset } from "../container-test-fixtures";
import { CONTAINER_PREFERENCES_STORAGE_KEY } from "./container-preferences";
import type { ContainerShelf } from "./types";

let ContainersClient: typeof import("./containers-client").ContainersClient;
const CONTAINERS_CLIENT_TEST_MODULE: string =
  "./containers-client.tsx?containers-client-test";

describe("ContainersClient", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    window.history.replaceState(null, "", "/inventory/containers");
    window.localStorage.clear();
    registerModuleMocks();
    ({ ContainersClient } = await import(CONTAINERS_CLIENT_TEST_MODULE));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    mock.restore();
  });

  test("reports the live bento item match count in the toolbar", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainersClient
            containers={buildContainers()}
            createAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            layoutSeed="load-one"
            urlView="bento"
            visualPresets={[]}
          />
        </ChakraTestWrapper>,
      );
    });

    const matchCount = container.querySelector("[data-bento-match-count]");
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Filter items inside containers"]',
    );

    expect(matchCount?.textContent).toContain("3 matches");
    expect(
      container.querySelector(
        '[role="radiogroup"][aria-label="Container view"]',
      ),
    ).not.toBeNull();
    expect(input).not.toBeNull();
    if (!input) return;

    await act(async () => {
      setInputValue(input, "voice");
    });

    expect(
      container.querySelector("[data-bento-match-count]")?.textContent,
    ).toContain("1 match");
  });

  test("links to the bounds editor from the toolbar", () => {
    const source = readFileSync(
      new URL("./containers-client.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('href="/inventory/containers/bounds"');
    expect(source).toContain('aria-label="Open bounds editor"');
    expect(source).toContain("<ScanLineIcon");
  });

  test("shows debug hover controls and changes the forced state", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainersClient
            containers={buildContainers()}
            createAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            debugBounds
            layoutSeed="load-one"
            urlView="bento"
            visualPresets={[]}
          />
        </ChakraTestWrapper>,
      );
    });

    const control = container.querySelector("[data-debug-reveal-control]");
    const hoveredOption = control?.querySelector<HTMLInputElement>(
      'input[type="radio"][value="hovered"]',
    );

    expect(control).not.toBeNull();
    expect(
      container
        .querySelector("[data-testid='bento-view']")
        ?.getAttribute("data-debug-reveal-state"),
    ).toBe("auto");

    await act(async () => {
      hoveredOption?.click();
    });

    expect(
      container
        .querySelector("[data-testid='bento-view']")
        ?.getAttribute("data-debug-reveal-state"),
    ).toBe("hovered");
    expect(hoveredOption?.checked).toBe(true);
  });

  test("uses the saved view when the URL has no valid override", async () => {
    savePreferences({
      scrollContainerId: "container-two",
      version: 1,
      view: "bento",
    });

    await renderClient();

    expect(
      container.querySelector("[data-testid='bento-view']"),
    ).not.toBeNull();
  });

  test("lets a valid URL view override and replace the saved view", async () => {
    savePreferences({
      scrollContainerId: "container-two",
      version: 1,
      view: "bento",
    });

    await renderClient({ urlView: "scroll" });

    expect(
      container
        .querySelector("[data-testid='scroll-stack']")
        ?.getAttribute("data-selected-id"),
    ).toBe("container-two");
    expect(loadPreferences()).toEqual({
      scrollContainerId: "container-two",
      version: 1,
      view: "scroll",
    });
  });

  test("restores the saved scroll container when switching from bento", async () => {
    savePreferences({
      scrollContainerId: "container-two",
      version: 1,
      view: "bento",
    });
    await renderClient();

    const scrollToggle = container.querySelector<HTMLInputElement>(
      '[aria-label="Full-screen scroll"]',
    );
    await act(async () => {
      scrollToggle?.click();
    });

    expect(
      container
        .querySelector("[data-testid='scroll-stack']")
        ?.getAttribute("data-selected-id"),
    ).toBe("container-two");
    expect(loadPreferences()).toEqual({
      scrollContainerId: "container-two",
      version: 1,
      view: "scroll",
    });
    expect(window.location.search).toBe("?view=scroll");
  });

  test("stores active containers only while the scroll view is mounted", async () => {
    await renderClient({ urlView: "scroll" });

    const activateSecond = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-container-two"]',
    );
    await act(async () => {
      activateSecond?.click();
    });

    expect(loadPreferences()).toEqual({
      scrollContainerId: "container-two",
      version: 1,
      view: "scroll",
    });
  });

  async function renderClient({
    urlView,
  }: {
    urlView?: "bento" | "scroll";
  } = {}) {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <ContainersClient
            containers={buildContainers()}
            createAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            layoutSeed="load-one"
            urlView={urlView}
            visualPresets={[]}
          />
        </ChakraTestWrapper>,
      );
    });
  }

  function savePreferences(value: unknown): void {
    window.localStorage.setItem(
      CONTAINER_PREFERENCES_STORAGE_KEY,
      JSON.stringify(value),
    );
  }

  function loadPreferences(): unknown {
    const value = window.localStorage.getItem(
      CONTAINER_PREFERENCES_STORAGE_KEY,
    );
    return value ? JSON.parse(value) : null;
  }
});

function buildContainers(): ContainerShelf[] {
  return [
    {
      id: "container-one",
      itemCount: 2,
      items: [
        {
          audioId: null,
          hasAudio: false,
          id: "item-passport",
          imageId: null,
          textPreview: "Typed travel note",
          title: "Passport pouch",
        },
        {
          audioId: null,
          hasAudio: false,
          id: "item-camera",
          imageId: "image-camera",
          textPreview: null,
          title: "Camera",
        },
      ],
      location: "Hall closet",
      name: "Travel tote",
      referenceId: "BIN-0001",
      visualPreset: testContainerVisualPreset,
      visualPresetKey: testContainerVisualPreset.id,
    },
    {
      id: "container-two",
      itemCount: 1,
      items: [
        {
          audioId: "audio-keys",
          hasAudio: true,
          id: "item-keys",
          imageId: null,
          textPreview: null,
          title: "Spare keys",
        },
      ],
      location: "Entryway",
      name: "Small drawer",
      referenceId: "BIN-0002",
      visualPreset: testContainerVisualPreset,
      visualPresetKey: testContainerVisualPreset.id,
    },
  ];
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(
    new window.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }),
  );
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}

function registerModuleMocks(): void {
  mock.module("next/link", () => ({
    default: ({
      children,
      href,
      prefetch: _prefetch,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & {
      href: string;
      prefetch?: boolean;
    }) => (
      <a href={href} {...props}>
        {children}
      </a>
    ),
  }));

  mock.module("next/navigation", () => ({
    notFound: () => {
      throw new Error("Not found");
    },
    redirect: () => {},
    usePathname: () => "/inventory/containers",
    useRouter: () => ({
      push() {},
      replace() {},
      refresh() {},
    }),
    useSearchParams: () => new URLSearchParams(),
  }));

  mock.module("./search-pill", () => ({
    controlSurface: {},
    SearchPill: ({
      end,
      endOffset: _endOffset,
      onChange,
      ...props
    }: InputHTMLAttributes<HTMLInputElement> & { end?: React.ReactNode; endOffset?: string }) => (
      <>
        <input
          {...props}
          onInput={(event) =>
            onChange?.(event as unknown as ChangeEvent<HTMLInputElement>)
          }
        />
        {end}
      </>
    ),
  }));

  mock.module("./bento-view", () => ({
    BentoView: ({ debugRevealState }: { debugRevealState?: string }) => (
      <div
        data-debug-reveal-state={debugRevealState}
        data-testid="bento-view"
      />
    ),
  }));

  mock.module("./container-search", () => ({
    ContainerSearch: () => <div />,
  }));

  mock.module("./scroll-stack", () => ({
    ScrollStack: ({
      onActiveChange,
      selectedId,
    }: {
      onActiveChange?: (id: string) => void;
      selectedId?: string;
    }) => (
      <div data-selected-id={selectedId} data-testid="scroll-stack">
        <button
          data-testid="activate-container-two"
          onClick={() => onActiveChange?.("container-two")}
          type="button"
        />
      </div>
    ),
  }));

  mock.module("./container-form-dialog", () => ({
    ContainerFormDialog: () => null,
  }));
}
