"use client";

import {
  Grid,
  Box,
  Icon,
  Image,
  Progress,
  type SystemStyleObject,
} from "@chakra-ui/react";

import { AudioLinesIcon, TypeIcon, VideoIcon, Volume2Icon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type InventoryItemAudioPreviewController,
  useInventoryItemAudioPreview,
} from "./inventory-item-audio-preview";
import type { InventoryItemMedia } from "./inventory-item-media";

const IMAGE_SLIDESHOW_INITIAL_DELAY_MS = 250;
const IMAGE_SLIDESHOW_TRANSITION_MS = 500;

const AudioPreviewContext =
  createContext<InventoryItemAudioPreviewController | null>(null);
const AudioPreviewActionsContext = createContext<Pick<
  InventoryItemAudioPreviewController,
  "start" | "stop"
> | null>(null);

export function InventoryItemMediaProvider({
  children,
}: {
  children: ReactNode;
}) {
  const controller = useInventoryItemAudioPreview();
  const { start, stop } = controller;
  const actions = useMemo(() => ({ start, stop }), [start, stop]);

  return (
    <AudioPreviewContext value={controller}>
      {controller.media}
      <AudioPreviewActionsContext value={actions}>
        {children}
      </AudioPreviewActionsContext>
    </AudioPreviewContext>
  );
}

export function InventoryItemAudioHoverTarget({
  audioId,
  audioSrc,
  children,
  className,
}: {
  audioId: string | null;
  audioSrc?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const handlers = useInventoryItemAudioHoverHandlers(audioId, audioSrc);
  if (!handlers) return <>{children}</>;

  return (
    <Box
      as="span"
      className={className}
      data-inventory-audio-hover-target=""
      {...handlers}
    >
      {children}
    </Box>
  );
}

export function useInventoryItemAudioHoverHandlers(
  audioId: string | null,
  audioSrc?: string | null,
) {
  const actions = useContext(AudioPreviewActionsContext);
  if (!audioId || !audioSrc) return undefined;

  const start = () => {
    void actions?.start(audioId, audioSrc);
  };
  const stop = () => actions?.stop(audioId);
  return { onFocus: start, onBlur: stop, onMouseEnter: start, onMouseLeave: stop };
}

export function InventoryItemMediaPreview({
  audioPreview,
  className,
  css,
  compact = false,
  media,
  imagePresentation = "cover",
  presentation = "card",
  focusable = presentation === "card",
}: {
  audioPreview?: InventoryItemAudioPreviewController;
  className?: string;
  css?: SystemStyleObject;
  compact?: boolean;
  focusable?: boolean;
  imagePresentation?: "contain-transparent-perimeter" | "cover";
  media: InventoryItemMedia;
  presentation?: "card" | "tile";
}) {
  const sharedAudioPreview = useContext(AudioPreviewContext);
  const controller = audioPreview ?? sharedAudioPreview;

  return (
    <Box
      as="span"
      aria-label={
        focusable && media.type === "audio" ? "Preview audio" : undefined
      }
      className={className}
      css={{
        position: "relative",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        ...(presentation === "tile"
          ? { boxSize: "full", borderRadius: "inherit" }
          : {}),
        ...css,
      }}
      data-audio-id={media.type === "audio" ? media.audioId : undefined}
      data-inventory-item-media-preview=""
      data-media-type={media.type}
      onBlur={() => {
        if (focusable && media.type === "audio" && media.audioId) {
          controller?.stop(media.audioId);
        }
      }}
      onClick={() => {
        if (focusable && media.type === "audio" && media.audioId && media.src) {
          void controller?.start(media.audioId, media.src);
        }
      }}
      onFocus={() => {
        if (focusable && media.type === "audio" && media.audioId && media.src) {
          void controller?.start(media.audioId, media.src);
        }
      }}
      onKeyDown={(event) => {
        if (
          focusable &&
          media.type === "audio" &&
          media.audioId &&
          media.src &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          void controller?.start(media.audioId, media.src);
        }
      }}
      onMouseEnter={() => {
        if (media.type === "audio" && media.audioId && media.src) {
          void controller?.start(media.audioId, media.src);
        }
      }}
      onMouseLeave={() => {
        if (media.type === "audio" && media.audioId) {
          controller?.stop(media.audioId);
        }
      }}
      role={focusable && media.type === "audio" ? "button" : undefined}
      tabIndex={focusable && media.type === "audio" ? 0 : undefined}
    >
      <MediaContent
        audioPreview={controller}
        compact={compact}
        imagePresentation={imagePresentation}
        media={media}
        presentation={presentation}
      />
    </Box>
  );
}

function MediaContent({
  audioPreview,
  compact,
  imagePresentation,
  media,
  presentation,
}: {
  audioPreview: InventoryItemAudioPreviewController | null | undefined;
  compact: boolean;
  imagePresentation: "contain-transparent-perimeter" | "cover";
  media: InventoryItemMedia;
  presentation: "card" | "tile";
}) {
  switch (media.type) {
    case "image":
      return (
        <ImagePreview imagePresentation={imagePresentation} media={media} />
      );
    case "audio":
      return (
        <AudioPreview
          audioPreview={audioPreview}
          compact={compact}
          media={media}
          presentation={presentation}
        />
      );
    case "video":
      return (
        <VideoPreview
          compact={compact}
          focusable={presentation === "card"}
          media={media}
          presentation={presentation}
        />
      );
    case "text":
      return (
        <TextPreview
          compact={compact}
          media={media}
          presentation={presentation}
        />
      );
  }
}

function ImagePreview({
  imagePresentation,
  media,
}: {
  imagePresentation: "contain-transparent-perimeter" | "cover";
  media: Extract<InventoryItemMedia, { type: "image" }>;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [containedSources, setContainedSources] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [isEngaged, setIsEngaged] = useState(false);
  const [showSlideshowImages, setShowSlideshowImages] = useState(false);
  const collapseTimeoutRef = useRef<number | undefined>(undefined);
  const isFocusedRef = useRef(false);
  const isHoveredRef = useRef(false);

  function clearCollapseTimeout() {
    if (collapseTimeoutRef.current === undefined) return;

    window.clearTimeout(collapseTimeoutRef.current);
    collapseTimeoutRef.current = undefined;
  }

  function startEngagement(kind: "focus" | "hover") {
    if (kind === "focus") isFocusedRef.current = true;
    if (kind === "hover") isHoveredRef.current = true;

    clearCollapseTimeout();
    setShowSlideshowImages(true);
    setIsEngaged(true);
  }

  function stopEngagement(kind: "focus" | "hover") {
    if (kind === "focus") isFocusedRef.current = false;
    if (kind === "hover") isHoveredRef.current = false;
    if (isFocusedRef.current || isHoveredRef.current) return;

    setIsEngaged(false);
    setActiveIndex(0);
    clearCollapseTimeout();
    collapseTimeoutRef.current = window.setTimeout(() => {
      setShowSlideshowImages(false);
      collapseTimeoutRef.current = undefined;
    }, IMAGE_SLIDESHOW_TRANSITION_MS);
  }

  useEffect(() => {
    if (!isEngaged || media.sources.length < 2) return;

    let interval: number | undefined;
    const advance = () => {
      setActiveIndex((current) => (current + 1) % media.sources.length);
    };
    const initialDelay = window.setTimeout(() => {
      advance();
      interval = window.setInterval(advance, 2000);
    }, IMAGE_SLIDESHOW_INITIAL_DELAY_MS);

    return () => {
      window.clearTimeout(initialDelay);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [isEngaged, media.sources.length]);

  useEffect(
    () => () => {
      clearCollapseTimeout();
    },
    [],
  );

  return (
    <Box
      as="span"
      position="absolute"
      inset="0"
      data-image-slideshow=""
      onBlur={() => stopEngagement("focus")}
      onFocus={() => startEngagement("focus")}
      onMouseEnter={() => startEngagement("hover")}
      onMouseLeave={() => stopEngagement("hover")}
    >
      {media.sources
        .slice(0, showSlideshowImages ? undefined : 1)
        .map((source, index) => (
          // eslint-disable-next-line @next/next/no-img-element -- Private authenticated media route.
          <Image
            alt={index === activeIndex ? media.alt : ""}
            aria-hidden={index === activeIndex ? undefined : "true"}
            position="absolute"
            inset="0"
            boxSize="full"
            transition="opacity 500ms ease-out"
            _motionReduce={{ transition: "none" }}
            style={{
              objectFit:
                imagePresentation === "contain-transparent-perimeter" &&
                containedSources.has(source)
                  ? "contain"
                  : "cover",
            }}
            opacity={index === activeIndex ? 1 : 0}
            data-active={index === activeIndex ? "true" : "false"}
            data-slideshow-image=""
            decoding="async"
            draggable={false}
            key={source}
            loading="lazy"
            onLoad={(event) => {
              if (
                imagePresentation !== "contain-transparent-perimeter" ||
                containedSources.has(source)
              ) {
                return;
              }

              if (
                imageElementHasFullyTransparentPerimeter(event.currentTarget)
              ) {
                setContainedSources((current) => new Set([...current, source]));
              }
            }}
            src={source}
          />
        ))}
      <Box
        as="span"
        pointerEvents="none"
        position="absolute"
        inset="0"
        background="linear-gradient(to top, rgb(0 0 0 / .12), transparent, rgb(255 255 255 / .12))"
      />
    </Box>
  );
}

export function imageHasFullyTransparentPerimeter({
  data,
  height,
  width,
}: Pick<ImageData, "data" | "height" | "width">): boolean {
  if (width < 1 || height < 1) return false;

  for (let x = 0; x < width; x += 1) {
    if (imageAlphaAt(data, width, x, 0) !== 0) return false;
    if (imageAlphaAt(data, width, x, height - 1) !== 0) return false;
  }

  for (let y = 1; y < height - 1; y += 1) {
    if (imageAlphaAt(data, width, 0, y) !== 0) return false;
    if (imageAlphaAt(data, width, width - 1, y) !== 0) return false;
  }

  return true;
}

function imageAlphaAt(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): number {
  return data[(y * width + x) * 4 + 3] ?? 255;
}

function imageElementHasFullyTransparentPerimeter(
  image: HTMLImageElement,
): boolean {
  if (image.naturalWidth < 1 || image.naturalHeight < 1) return false;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;

    for (const y of [0, image.naturalHeight - 1]) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        0,
        y,
        image.naturalWidth,
        1,
        0,
        0,
        image.naturalWidth,
        1,
      );
      if (
        !imageHasFullyTransparentPerimeter(
          context.getImageData(0, 0, canvas.width, canvas.height),
        )
      ) {
        return false;
      }
    }

    canvas.width = 1;
    canvas.height = image.naturalHeight;
    for (const x of [0, image.naturalWidth - 1]) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        x,
        0,
        1,
        image.naturalHeight,
        0,
        0,
        1,
        image.naturalHeight,
      );
      if (
        !imageHasFullyTransparentPerimeter(
          context.getImageData(0, 0, canvas.width, canvas.height),
        )
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function VideoPreview({
  compact,
  focusable,
  media,
  presentation,
}: {
  compact: boolean;
  focusable: boolean;
  media: Extract<InventoryItemMedia, { type: "video" }>;
  presentation: "card" | "tile";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const showTileDecoration = presentation === "tile" && !compact;

  function start() {
    void videoRef.current?.play().catch(() => {});
  }

  function stop() {
    const video = videoRef.current;
    if (!video) return;

    video.pause();
    try {
      video.currentTime = 0;
    } catch {
      // Metadata may not be available yet.
    }
  }

  return (
    <Box
      as="span"
      aria-label={focusable ? `Preview ${media.title}` : undefined}
      position="absolute"
      inset="0"
      data-video-preview=""
      onBlur={focusable ? stop : undefined}
      onClick={focusable ? start : undefined}
      onFocus={focusable ? start : undefined}
      onMouseEnter={start}
      onMouseLeave={stop}
      role={focusable ? "button" : undefined}
      tabIndex={focusable ? 0 : undefined}
    >
      <Box
        asChild
        boxSize="full"
        objectFit="cover"
        transform={showTileDecoration ? "scale(0.92)" : undefined}
        borderRadius={showTileDecoration ? "20%" : undefined}
        shadow={showTileDecoration ? "sm" : undefined}
      >
        <video
          aria-label={media.title}
          loop
          muted
          playsInline
          poster={media.poster}
          preload="metadata"
          ref={videoRef}
          src={media.src}
        />
      </Box>
      <Grid
        as="span"
        pointerEvents="none"
        position="absolute"
        inset="0"
        placeItems="center"
        background="blackAlpha.100"
      >
        <Grid
          as="span"
          placeItems="center"
          color={showTileDecoration ? "gray.800" : "white"}
          boxSize={showTileDecoration ? "34%" : "42%"}
          rounded={showTileDecoration ? "full" : undefined}
          borderWidth={showTileDecoration ? "1px" : undefined}
          borderColor="whiteAlpha.700"
          bg={showTileDecoration ? "whiteAlpha.600" : undefined}
          backdropFilter={showTileDecoration ? "blur(12px)" : undefined}
        >
          <VideoIcon
            aria-hidden="true"
            style={{
              width: showTileDecoration ? "54%" : "100%",
              height: showTileDecoration ? "54%" : "100%",
            }}
            fill={showTileDecoration ? "none" : "currentColor"}
            strokeWidth={1.5}
          />
        </Grid>
      </Grid>
    </Box>
  );
}

function TextPreview({
  compact,
  media,
  presentation,
}: {
  compact: boolean;
  media: Extract<InventoryItemMedia, { type: "text" }>;
  presentation: "card" | "tile";
}) {
  if (presentation === "card") {
    return (
      <CardPlaceholder
        compact={compact}
        icon={<Icon as={TypeIcon} boxSize="5" />}
        label="Text-only item"
      />
    );
  }

  if (compact) {
    return (
      <Icon
        as={TypeIcon}
        aria-hidden="true"
        boxSize="48%"
        opacity={0.7}
        strokeWidth={1.75}
      />
    );
  }

  return (
    <Grid
      as="span"
      boxSize="100%"
      alignContent="center"
      justifyItems="center"
      gap="5%"
      overflow="hidden"
      px="10%"
      pb="16%"
      textAlign="center"
    >
      <Icon
        as={TypeIcon}
        aria-hidden="true"
        boxSize="28%"
        minHeight="4"
        minWidth="4"
        opacity={0.75}
        strokeWidth={1.75}
      />
      <Box
        as="span"
        lineClamp={2}
        fontWeight="medium"
        fontSize="clamp(0.45rem,1vw,0.72rem)"
        lineHeight="tight"
      >
        {media.text || media.title}
      </Box>
    </Grid>
  );
}

function AudioPreview({
  audioPreview,
  compact,
  media,
  presentation,
}: {
  audioPreview: InventoryItemAudioPreviewController | null | undefined;
  compact: boolean;
  media: Extract<InventoryItemMedia, { type: "audio" }>;
  presentation: "card" | "tile";
}) {
  const isActive =
    Boolean(media.audioId) &&
    audioPreview?.activeAudioId === media.audioId &&
    audioPreview.isPlaying;

  if (presentation === "card") {
    return (
      <CardPlaceholder
        compact={compact}
        icon={
          <Grid
            as="span"
            position="relative"
            boxSize="5"
            flexShrink={0}
            placeItems="center"
            data-audio-glyph=""
          >
            <Icon
              as={AudioLinesIcon}
              aria-hidden="true"
              position="absolute"
              inset="0"
              boxSize="full"
              transition="opacity 150ms"
              _motionReduce={{ transition: "none" }}
              opacity={isActive ? 0 : 1}
              data-audio-idle-glyph=""
            />
            <Grid
              as="span"
              aria-hidden="true"
              position="absolute"
              inset="0"
              boxSize="full"
              placeItems="center"
              transition="opacity 150ms"
              _motionReduce={{ transition: "none" }}
              opacity={isActive ? 1 : 0}
              data-audio-playing-glyph=""
            >
              {isActive ? <Icon as={Volume2Icon} boxSize="100%" /> : null}
            </Grid>
          </Grid>
        }
        label={isActive ? "Playing audio" : "Audio-only item"}
      />
    );
  }

  if (!isActive) {
    return (
      <AudioLinesIcon
        aria-hidden="true"
        style={{
          width: compact ? "52%" : "38%",
          height: compact ? "52%" : "38%",
          color: "var(--chakra-colors-fg-muted)",
        }}
        strokeWidth={compact ? 2 : 1.75}
      />
    );
  }

  return (
    <Grid
      as="span"
      width="75%"
      justifyItems="center"
      gap="2"
      data-audio-playing=""
    >
      <Volume2Icon
        aria-hidden="true"
        style={{ width: compact ? 20 : 32, height: compact ? 20 : 32 }}
      />
      <Box as="span" srOnly={true}>
        Playing audio
      </Box>
      <Progress.Root
        width="full"
        value={Math.min(100, Math.max(0, audioPreview.progress * 100))}
      >
        <Progress.Track aria-label="Audio playback progress">
          <Progress.Range />
        </Progress.Track>
      </Progress.Root>
    </Grid>
  );
}

function CardPlaceholder({
  compact,
  icon,
  label,
}: {
  compact: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Grid as="span" boxSize="100%" placeItems="center" background="bg.subtle">
      <Grid as="span" placeItems="center" gap="2" color="fg.muted">
        <Grid
          as="span"
          boxSize="10"
          placeItems="center"
          borderRadius="full"
          borderWidth="1px"
          borderColor="border"
          background="bg"
        >
          {icon}
        </Grid>
        {!compact ? (
          <Box as="span" textStyle="xs">
            {label}
          </Box>
        ) : null}
      </Grid>
    </Grid>
  );
}
