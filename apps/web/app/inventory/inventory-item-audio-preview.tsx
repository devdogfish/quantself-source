"use client";

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type InventoryItemAudioPreviewController = {
  activeAudioId: string | null;
  isPlaying: boolean;
  media: ReactElement;
  progress: number;
  start: (audioId: string, src: string) => Promise<void>;
  stop: (audioId?: string) => void;
};

export function useInventoryItemAudioPreview(): InventoryItemAudioPreviewController {
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeAudioIdRef = useRef<string | null>(null);
  const progressFrameRef = useRef<number | null>(null);
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const stopProgressAnimation = useCallback(() => {
    if (progressFrameRef.current === null) return;

    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(progressFrameRef.current);
    }
    progressFrameRef.current = null;
  }, []);

  const updateProgress = useCallback(function updateProgressFrame() {
    const audio = audioRef.current;

    if (!audio || audio.paused) {
      progressFrameRef.current = null;
      return;
    }

    const { currentTime, duration } = audio;
    setProgress(
      Number.isFinite(duration) && duration > 0
        ? Math.min(1, Math.max(0, currentTime / duration))
        : 0,
    );
    progressFrameRef.current =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(updateProgressFrame)
        : null;
  }, []);

  const startProgressAnimation = useCallback(() => {
    stopProgressAnimation();
    progressFrameRef.current =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(updateProgress)
        : null;
  }, [stopProgressAnimation, updateProgress]);

  const stop = useCallback(
    (audioId?: string) => {
      if (audioId && activeAudioIdRef.current !== audioId) return;

      stopProgressAnimation();
      const audio = audioRef.current;

      if (audio) {
        if (!audio.paused) {
          audio.pause();
        }

        try {
          audio.currentTime = 0;
        } catch {
          // Metadata may not be available yet.
        }
      }

      activeAudioIdRef.current = null;
      setActiveAudioId(null);
      setIsPlaying(false);
      setProgress(0);
    },
    [stopProgressAnimation],
  );

  const start = useCallback(
    async (audioId: string, src: string) => {
      const audio = audioRef.current;

      if (!audio) return;
      if (activeAudioIdRef.current === audioId && !audio.paused) return;

      if (!audio.paused) {
        audio.pause();
      }
      activeAudioIdRef.current = audioId;
      setActiveAudioId(audioId);
      setIsPlaying(false);
      setProgress(0);
      audio.src = src;

      try {
        audio.currentTime = 0;
      } catch {
        // Metadata may not be available yet.
      }

      try {
        await audio.play();
      } catch {
        stop(audioId);
      }
    },
    [stop],
  );

  useEffect(
    () => () => {
      stopProgressAnimation();
    },
    [stopProgressAnimation],
  );

  const media = (
    <audio
      aria-hidden="true"
      hidden
      onEnded={() => stop()}
      onError={() => stop()}
      onPause={() => {
        stopProgressAnimation();
        setIsPlaying(false);
      }}
      onPlay={() => {
        startProgressAnimation();
        setIsPlaying(true);
      }}
      onTimeUpdate={(event) => {
        const { currentTime, duration } = event.currentTarget;
        setProgress(
          Number.isFinite(duration) && duration > 0
            ? Math.min(1, Math.max(0, currentTime / duration))
            : 0,
        );
      }}
      preload="metadata"
      ref={audioRef}
    />
  );

  return {
    activeAudioId,
    isPlaying,
    media,
    progress,
    start,
    stop,
  };
}
