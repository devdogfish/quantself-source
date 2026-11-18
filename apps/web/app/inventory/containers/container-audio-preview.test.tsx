import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
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
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

let FrostedAudioTile: typeof import("./container-audio-preview").FrostedAudioTile;
let useContainerAudioPreview: typeof import("./container-audio-preview").useContainerAudioPreview;
type PreviewController = ReturnType<
  typeof import("./container-audio-preview").useContainerAudioPreview
>;
let latestController: PreviewController | undefined;

describe("container audio preview", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ FrostedAudioTile, useContainerAudioPreview } =
      await import("./container-audio-preview"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
    cleanupGlobals?.();
    cleanupGlobals = null;
    latestController = undefined;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => {
    mock.restore();
  });

  test("shows an audio icon without playback progress while idle", async () => {
    await renderTile({
      activeAudioId: null,
      isPlaying: false,
      progress: 0,
    });

    expect(container!.querySelector(".lucide-audio-lines")).not.toBeNull();
    expect(container!.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("shows playback status and accessible progress while playing", async () => {
    await renderTile({
      activeAudioId: "audio-1",
      isPlaying: true,
      progress: 0.375,
    });

    const progress = container!.querySelector('[role="progressbar"]');
    expect(container!.textContent).toContain("Playing audio");
    expect(container!.querySelector(".lucide-volume-2")).not.toBeNull();
    expect(progress?.getAttribute("aria-label")).toBe(
      "Audio playback progress",
    );
    expect(progress?.getAttribute("aria-valuenow")).toBe("37.5");
  });

  test.each([
    { expected: "0", progress: -0.1 },
    { expected: "0", progress: 0 },
    { expected: "50", progress: 0.5 },
    { expected: "100", progress: 1 },
    { expected: "100", progress: 1.1 },
  ])("clamps playback progress $progress", async ({ expected, progress }) => {
    await renderTile({
      activeAudioId: "audio-1",
      isPlaying: true,
      progress,
    });

    expect(
      container!
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe(expected);
  });

  test("does not show another audio item's playback status", async () => {
    await renderTile({
      activeAudioId: "audio-2",
      isPlaying: true,
      progress: 0.5,
    });

    expect(container!.querySelector(".lucide-audio-lines")).not.toBeNull();
    expect(container!.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("starts from the beginning and resets the shared media on leave", async () => {
    await act(async () => {
      root!.render(
        <ChakraTestWrapper>
          <PreviewHarness
            onController={(controller) => {
              latestController = controller;
            }}
          />
        </ChakraTestWrapper>,
      );
    });

    const audio = container!.querySelector("audio");

    if (!audio || !latestController) {
      throw new Error("Expected the preview hook to expose one audio element.");
    }

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
      currentTime: { configurable: true, value: 42, writable: true },
      duration: { configurable: true, value: 120 },
      paused: { configurable: true, get: () => paused },
      pause: { configurable: true, value: pause },
      play: { configurable: true, value: play },
    });

    await act(async () => {
      await latestController?.start(
        "audio-1",
        "/api/v1/inventory-items/item-1/media/audio-1",
      );
    });

    expect(audio.getAttribute("src")).toBe(
      "/api/v1/inventory-items/item-1/media/audio-1",
    );
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    expect(latestController?.activeAudioId).toBe("audio-1");
    expect(latestController?.isPlaying).toBe(true);

    audio.currentTime = 30;
    await act(async () => {
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(latestController?.progress).toBeCloseTo(0.25);

    const pauseCallsBeforeStop = pause.mock.calls.length;
    await act(async () => {
      latestController?.stop("audio-1");
    });

    expect(pause).toHaveBeenCalledTimes(pauseCallsBeforeStop + 1);
    expect(audio.currentTime).toBe(0);
    expect(latestController?.activeAudioId).toBeNull();
    expect(latestController?.isPlaying).toBe(false);
    expect(latestController?.progress).toBe(0);
  });

  test("updates playback progress on animation frames without timeupdate events", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    globalThis.requestAnimationFrame = mock(
      (callback: FrameRequestCallback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, callback);
        return frameId;
      },
    );
    globalThis.cancelAnimationFrame = mock((frameId: number) => {
      frames.delete(frameId);
    });

    await act(async () => {
      root!.render(
        <ChakraTestWrapper>
          <PreviewHarness
            onController={(controller) => {
              latestController = controller;
            }}
          />
        </ChakraTestWrapper>,
      );
    });

    const audio = container!.querySelector("audio");

    if (!audio || !latestController) {
      throw new Error("Expected the preview hook to expose one audio element.");
    }

    let paused = true;
    Object.defineProperties(audio, {
      currentTime: { configurable: true, value: 0, writable: true },
      duration: { configurable: true, value: 100 },
      paused: { configurable: true, get: () => paused },
      pause: {
        configurable: true,
        value: () => {
          paused = true;
          audio.dispatchEvent(new Event("pause"));
        },
      },
      play: {
        configurable: true,
        value: async () => {
          paused = false;
          audio.dispatchEvent(new Event("play"));
        },
      },
    });

    await act(async () => {
      await latestController?.start(
        "audio-1",
        "/api/v1/inventory-items/item-1/media/audio-1",
      );
    });

    expect(frames.size).toBe(1);
    audio.currentTime = 25;

    const [frameId, frame] = frames.entries().next().value ?? [];
    if (frameId === undefined || !frame) {
      throw new Error("Expected a scheduled progress animation frame.");
    }
    frames.delete(frameId);

    await act(async () => {
      frame(16);
    });

    expect(latestController?.progress).toBeCloseTo(0.25);
    expect(frames.size).toBe(1);

    await act(async () => {
      latestController?.stop("audio-1");
    });

    expect(frames.size).toBe(0);
  });

  async function renderTile(
    state: Pick<
      ReturnType<
        typeof import("./container-audio-preview").useContainerAudioPreview
      >,
      "activeAudioId" | "isPlaying" | "progress"
    >,
  ): Promise<void> {
    const controller = {
      activeAudioId: state.activeAudioId,
      isPlaying: state.isPlaying,
      media: <span hidden />,
      progress: state.progress,
      start: async () => {},
      stop: () => {},
    } as ReturnType<
      typeof import("./container-audio-preview").useContainerAudioPreview
    >;

    await act(async () => {
      root!.render(
        <ChakraTestWrapper>
          <FrostedAudioTile
            audioId="audio-1"
            controller={controller}
            src="/api/v1/inventory-items/item-1/media/audio-1"
          />
        </ChakraTestWrapper>,
      );
    });
  }
});

function PreviewHarness({
  onController,
}: {
  onController: (controller: PreviewController) => void;
}) {
  const controller = useContainerAudioPreview();

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  return controller.media;
}

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLAudioElement: globalThis.HTMLAudioElement,
    HTMLElement: globalThis.HTMLElement,
    HTMLMediaElement: globalThis.HTMLMediaElement,
    MouseEvent: globalThis.MouseEvent,
    MutationObserver: globalThis.MutationObserver,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLAudioElement: window.HTMLAudioElement,
    HTMLElement: window.HTMLElement,
    HTMLMediaElement: window.HTMLMediaElement,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    navigator: window.navigator,
    Node: window.Node,
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
