import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";

let ChakraTestWrapper: typeof import("./chakra/test-utils").ChakraTestWrapper;

let AudioPlayer: typeof import("./audio-player").AudioPlayer;

describe("AudioPlayer", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ AudioPlayer } = await import("./audio-player"));
    ({ ChakraTestWrapper } = await import("./chakra/test-utils"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    // Let popover focus restoration complete before removing DOM globals.
    // Let it finish with this window's Event constructors still installed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    container.remove();
    cleanupGlobals?.();
    cleanupGlobals = null;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => {
    mock.restore();
  });

  test("plays, pauses, tracks progress, and resets after completion", async () => {
    await renderPlayer();
    const audio = getAudio();
    let paused = true;
    const play = mock(async () => {
      paused = false;
      audio.dispatchEvent(new Event("play"));
    });
    const pause = mock(() => {
      paused = true;
      audio.dispatchEvent(new Event("pause"));
    });

    Object.defineProperties(audio, {
      currentTime: { configurable: true, value: 0, writable: true },
      duration: { configurable: true, value: 125.8 },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: pause },
      play: { configurable: true, value: play },
    });

    await dispatchMediaEvent(audio, "loadedmetadata");
    expect(container.textContent).not.toContain("2:05");

    await clickButton("Play Voice note");
    expect(play).toHaveBeenCalledTimes(1);
    expect(findButton("Pause Voice note")).not.toBeNull();

    audio.currentTime = 61.4;
    await dispatchMediaEvent(audio, "timeupdate");
    expect(container.textContent).toContain("1:01");

    await clickButton("Pause Voice note");
    expect(pause).toHaveBeenCalledTimes(1);
    expect(findButton("Play Voice note")).not.toBeNull();

    await clickButton("Play Voice note");
    await dispatchMediaEvent(audio, "ended");
    expect(findButton("Play Voice note")).not.toBeNull();
  });

  test("seeks with arrow keys and adjusts volume in a dismissible popover", async () => {
    await renderPlayer();
    const audio = getAudio();
    Object.defineProperties(audio, {
      currentTime: { configurable: true, value: 0, writable: true },
      duration: { configurable: true, value: 120 },
      muted: { configurable: true, value: true, writable: true },
      volume: { configurable: true, value: 1, writable: true },
    });
    await dispatchMediaEvent(audio, "loadedmetadata");
    const seek = container.querySelector<HTMLElement>(
      '[role="slider"][aria-label="Seek Voice note"]',
    )!;
    expect(seek).not.toBeNull();
    expect(seek.getAttribute("aria-valuetext")).toBe("0:00 of 2:00");
    await pressKey(seek, "ArrowRight");
    expect(audio.currentTime).toBeCloseTo(0.1);
    expect(
      document.querySelector('[aria-label="Adjust volume for Voice note"]'),
    ).toBeNull();
    await clickButton("Volume for Voice note");
    const volume = document.querySelector<HTMLElement>(
      '[role="slider"][aria-label="Adjust volume for Voice note"]',
    )!;
    expect(volume).not.toBeNull();
    await pressKey(volume, "ArrowDown");
    expect(audio.volume).toBeCloseTo(0.99);
    expect(audio.muted).toBe(false);
    await pressKey(volume, "Escape");
    expect(
      findButton("Volume for Voice note")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("reports playback and loading failures", async () => {
    await renderPlayer();
    const audio = getAudio();

    Object.defineProperties(audio, {
      paused: { configurable: true, value: true },
      play: {
        configurable: true,
        value: mock(async () => {
          throw new Error("Playback failed");
        }),
      },
    });

    await clickButton("Play Voice note");
    expect(container.textContent).toContain("Unable to play this audio note.");

    await dispatchMediaEvent(audio, "error");
    expect(container.textContent).toContain("Unable to load this audio note.");
  });

  async function renderPlayer(): Promise<void> {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <AudioPlayer label="Voice note" src="/audio/note.m4a" />
        </ChakraTestWrapper>,
      );
    });
  }

  function getAudio(): HTMLAudioElement {
    const audio = container.querySelector("audio");

    if (!audio) {
      throw new Error("Expected audio element.");
    }

    return audio;
  }

  function findButton(label: string): HTMLButtonElement | null {
    return container.querySelector(`button[aria-label="${label}"]`);
  }

  async function clickButton(label: string): Promise<void> {
    const button = findButton(label);

    if (!button) {
      throw new Error(`Expected button "${label}".`);
    }

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }
});

async function dispatchMediaEvent(
  audio: HTMLAudioElement,
  name: string,
): Promise<void> {
  await act(async () => {
    audio.dispatchEvent(new Event(name));
  });
}

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    CustomEvent: globalThis.CustomEvent,
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLAudioElement: globalThis.HTMLAudioElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLMediaElement: globalThis.HTMLMediaElement,
    MouseEvent: globalThis.MouseEvent,
    MutationObserver: globalThis.MutationObserver,
    KeyboardEvent: globalThis.KeyboardEvent,
    ResizeObserver: globalThis.ResizeObserver,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    CustomEvent: window.CustomEvent,
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLAudioElement: window.HTMLAudioElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLMediaElement: window.HTMLMediaElement,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    KeyboardEvent: window.KeyboardEvent,
    ResizeObserver: window.ResizeObserver,
    navigator: window.navigator,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
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

async function pressKey(element: HTMLElement, key: string) {
  await act(async () => {
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
