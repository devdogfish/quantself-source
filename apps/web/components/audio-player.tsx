"use client";

import { PauseIcon, PlayIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
  HStack,
  IconButton,
  Popover,
  Portal,
  Slider,
  Stack,
  Text,
} from "@chakra-ui/react";

type AudioPlayerProps = {
  label: string;
  src: string;
};

export function AudioPlayer({
  label,
  src,
}: AudioPlayerProps): React.ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    setPlaybackError(null);

    if (!audio.paused) {
      audio.pause();
      return;
    }

    try {
      await audio.play();
    } catch {
      setIsPlaying(false);
      setPlaybackError("Unable to play this audio note.");
    }
  }

  function seek(nextValue: number[]): void {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const nextTime = nextValue[0] ?? 0;
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function changeVolume(nextValue: number[]): void {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const nextVolume = nextValue[0] ?? 0;
    audio.volume = nextVolume;
    audio.muted = false;
    setVolume(nextVolume);
    setIsMuted(false);
  }

  const hasDuration = duration > 0;
  const showsMuted = isMuted || volume === 0;

  return (
    <Stack gap="2">
      <audio
        aria-hidden="true"
        hidden
        onDurationChange={(event) =>
          setDuration(normalizeDuration(event.currentTarget.duration))
        }
        onEnded={() => setIsPlaying(false)}
        onError={() => setPlaybackError("Unable to load this audio note.")}
        onLoadedMetadata={(event) =>
          setDuration(normalizeDuration(event.currentTarget.duration))
        }
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onVolumeChange={(event) => {
          setIsMuted(event.currentTarget.muted);
          setVolume(event.currentTarget.volume);
        }}
        preload="metadata"
        ref={audioRef}
        src={src}
      />
      <HStack minW="0" gap="2">
        <IconButton
          aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
          onClick={togglePlayback}
          size="sm"
          type="button"
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <Text
          as="span"
          w="10"
          flexShrink="0"
          color="fg.muted"
          fontSize="xs"
          fontVariantNumeric="tabular-nums"
        >
          {formatTime(currentTime)}
        </Text>
        <Slider.Root
          aria-label={[`Seek ${label}`]}
          minW="0"
          flex="1"
          disabled={!hasDuration}
          max={hasDuration ? duration : 1}
          onValueChange={({ value }) => seek(value)}
          step={0.1}
          value={[currentTime]}
        >
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumb
              index={0}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            >
              <Slider.HiddenInput />
            </Slider.Thumb>
          </Slider.Control>
        </Slider.Root>
        <Popover.Root
          lazyMount
          unmountOnExit
          positioning={{ placement: "top", gutter: 8 }}
        >
          <Popover.Trigger asChild>
            <IconButton
              aria-label={`Volume for ${label}`}
              size="sm"
              type="button"
              variant="ghost"
            >
              {showsMuted ? <VolumeXIcon /> : <Volume2Icon />}
            </IconButton>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content
                w="auto"
                p="4"
                aria-label={`Volume for ${label}`}
              >
                <Slider.Root
                  aria-label={[`Adjust volume for ${label}`]}
                  h="32"
                  max={1}
                  onValueChange={({ value }) => changeVolume(value)}
                  orientation="vertical"
                  step={0.01}
                  value={[volume]}
                >
                  <Slider.Control>
                    <Slider.Track>
                      <Slider.Range />
                    </Slider.Track>
                    <Slider.Thumb index={0}>
                      <Slider.HiddenInput />
                    </Slider.Thumb>
                  </Slider.Control>
                </Slider.Root>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
      </HStack>
      {playbackError ? (
        <Text color="fg.error" fontSize="xs" role="alert">
          {playbackError}
        </Text>
      ) : null}
    </Stack>
  );
}

function normalizeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
