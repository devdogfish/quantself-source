"use client";

// Three read-only container-page variants, switchable via ?variant=a|c|d.

import { Box, Flex, Grid, GridItem, Text } from "@chakra-ui/react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { SearchPill } from "../search-pill";
import { LayeredContainer } from "./layered-container";
import type { PrototypeContainer, PrototypeItem } from "./mock-data";
import styles from "./prototype.module.css";

type Variant = "a" | "c" | "d";
type RevealEffect = "blur" | "fade";

const variants: Array<{ id: Variant; label: string }> = [
  { id: "a", label: "Immersive stack" },
  { id: "c", label: "Drag carousel" },
  { id: "d", label: "Bento browse" },
];

function ContainerPicker({
  activeId,
  containers,
  onSelect,
}: {
  activeId?: string;
  containers: PrototypeContainer[];
  onSelect: (container: PrototypeContainer) => void;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const matches = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return containers;

    return containers.filter((container) => {
      const searchable =
        `${container.referenceId} ${container.name} ${container.location}`.toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }, [containers, query]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function choose(container: PrototypeContainer) {
    setQuery("");
    setOpen(false);
    onSelect(container);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedIndex((current) =>
        matches.length
          ? (current + direction + matches.length) % matches.length
          : 0,
      );
      return;
    }
    if (event.key === "Enter" && open && matches[highlightedIndex]) {
      event.preventDefault();
      choose(matches[highlightedIndex]);
    }
  }

  const activeContainer = containers.find(
    (container) => container.id === activeId,
  );

  return (
    <Box position="relative" w="full" maxW="28rem" ref={rootRef}>
      <SearchPill
        className={styles.searchPill}
        end={<ChevronDownIcon aria-hidden="true" size={16} />}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label="Jump to a container"
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlightedIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={activeContainer?.name ?? "Find a container…"}
        role="combobox"
        value={query}
      />

      {open ? (
        <div
          className={styles.options}
          id={listId}
          role="listbox"
        >
          {matches.length ? (
            matches.map((container, index) => (
              <button
                aria-selected={container.id === activeId}
                className={styles.option}
                data-highlighted={index === highlightedIndex}
                key={container.id}
                onClick={() => choose(container)}
                onPointerMove={() => setHighlightedIndex(index)}
                role="option"
                type="button"
              >
                <span className={styles.optionBody}>
                  <span className={styles.optionName}>
                    {container.name}
                  </span>
                  <span className={styles.optionLocation}>
                    {container.referenceId} · {container.location}
                  </span>
                </span>
                <span className={styles.optionCount}>
                  {container.itemCount}
                </span>
              </button>
            ))
          ) : (
            <p className={styles.noOptions}>
              No containers found
            </p>
          )}
        </div>
      ) : null}
    </Box>
  );
}

function StackView({
  containers,
  effect,
}: {
  containers: PrototypeContainer[];
  effect: RevealEffect;
}) {
  const [activeId, setActiveId] = useState(containers[0]?.id);

  function jumpTo(container: PrototypeContainer) {
    setActiveId(container.id);
    document
      .getElementById(`prototype-container-${container.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <Box position="relative">
      <div className={styles.stickyHeader}>
        <ContainerPicker
          activeId={activeId}
          containers={containers}
          onSelect={jumpTo}
        />
      </div>
      <div className={styles.stackViewport}>
        {containers.map((container, index) => (
          <section
            className={styles.stackSlide}
            id={`prototype-container-${container.id}`}
            key={container.id}
          >
            <Box mx="auto" w="full" maxW="1600px">
              <p className={styles.stackCount}>
                {String(index + 1).padStart(2, "0")} /{" "}
                {String(containers.length).padStart(2, "0")}
              </p>
              <LayeredContainer
                container={container}
                effect={effect}
                priority={index === 0}
              />
            </Box>
          </section>
        ))}
      </div>
    </Box>
  );
}

type DragState = {
  active: boolean;
  pointerId: number;
  startScrollLeft: number;
  startX: number;
};

function FocusView({
  containers,
  effect,
}: {
  containers: PrototypeContainer[];
  effect: RevealEffect;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);
  const dragRef = useRef<DragState>({
    active: false,
    pointerId: -1,
    startScrollLeft: 0,
    startX: 0,
  });
  const activeContainer = containers[activeIndex];

  const goTo = useCallback(
    (index: number, behavior: ScrollBehavior = "smooth") => {
      if (!containers.length) return;
      const nextIndex = (index + containers.length) % containers.length;
      setActiveIndex(nextIndex);
      viewportRef.current?.scrollTo({
        behavior,
        left: viewportRef.current.clientWidth * nextIndex,
      });
    },
    [containers.length],
  );

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest("a, input")) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    draggedRef.current = false;
    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startScrollLeft: viewport.scrollLeft,
      startX: event.clientX,
    };
    viewport.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      !dragRef.current.active ||
      dragRef.current.pointerId !== event.pointerId
    ) {
      return;
    }
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 5) draggedRef.current = true;
    viewport.scrollLeft = dragRef.current.startScrollLeft - delta;
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      !dragRef.current.active ||
      dragRef.current.pointerId !== event.pointerId
    ) {
      return;
    }
    dragRef.current.active = false;
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    goTo(Math.round(viewport.scrollLeft / viewport.clientWidth));
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      viewport.scrollTo({
        behavior: "instant",
        left: viewport.clientWidth * activeIndex,
      });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [activeIndex]);

  if (!activeContainer) return <EmptyState />;

  return (
    <Flex direction="column" minH="100svh">
      <div className={styles.header}>
        <ContainerPicker
          activeId={activeContainer.id}
          containers={containers}
          onSelect={(container) =>
            goTo(
              containers.findIndex((candidate) => candidate.id === container.id),
            )
          }
        />
      </div>
      <Flex as="main" flex="1" align="center" overflow="hidden" py="6">
        <Box w="full">
          <div className={styles.carouselStatus}>
            <span>
              {String(activeIndex + 1).padStart(2, "0")} /{" "}
              {String(containers.length).padStart(2, "0")}
            </span>
            <span>Drag to browse</span>
          </div>
          <div
            className={styles.carousel}
            onClickCapture={(event) => {
              if (!draggedRef.current) return;
              event.preventDefault();
              event.stopPropagation();
              draggedRef.current = false;
            }}
            onPointerCancel={finishDrag}
            onPointerDown={startDrag}
            onLostPointerCapture={() => {
              dragRef.current.active = false;
            }}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            ref={viewportRef}
          >
            {containers.map((container) => (
              <div
                className={styles.carouselSlide}
                key={container.id}
              >
                <LayeredContainer
                  className={styles.sceneWidth}
                  container={container}
                  effect={effect}
                  priority
                />
              </div>
            ))}
          </div>
          <Flex mb="14" mt="3" justify="center" gap="1.5">
            {containers.map((container, index) => (
              <button
                aria-label={`Show ${container.name}`}
                aria-pressed={index === activeIndex}
                className={styles.carouselDot}
                key={container.id}
                onClick={() => goTo(index)}
                type="button"
              />
            ))}
          </Flex>
        </Box>
      </Flex>
    </Flex>
  );
}

function BrowseView({
  containers,
  effect,
}: {
  containers: PrototypeContainer[];
  effect: RevealEffect;
}) {
  const [itemQuery, setItemQuery] = useState("");
  const normalizedQuery = itemQuery.trim().toLocaleLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const orderedContainers = useMemo(
    () =>
      containers.toSorted(
        (left, right) =>
          ["6L", "39L", "80L"].indexOf(left.presetId) -
          ["6L", "39L", "80L"].indexOf(right.presetId),
      ),
    [containers],
  );
  const visibleIdsByContainer = new Map(
    containers.map((container) => [
      container.id,
      new Set(
        container.items
          .filter((item) => itemMatches(item, terms))
          .map((item) => item.id),
      ),
    ]),
  );
  const realContainers = containers.filter(
    (container) => !container.presetFitCheck,
  );
  const matchingCount = normalizedQuery
    ? realContainers.reduce(
        (total, container) =>
          total + (visibleIdsByContainer.get(container.id)?.size ?? 0),
        0,
      )
    : realContainers.reduce(
        (total, container) => total + container.itemCount,
        0,
      );

  if (!containers.length) return <EmptyState />;

  return (
    <div className={styles.browse}>
      <header className={styles.browseHeader}>
        <Box flex="1" maxW="36rem">
          <SearchPill
            className={styles.searchPill}
            aria-label="Filter items inside containers"
            onChange={(event) => setItemQuery(event.target.value)}
            placeholder="Find an item inside every container…"
            type="search"
            value={itemQuery}
          />
        </Box>
        <span
          aria-live="polite"
          className={styles.matchCount}
        >
          {matchingCount} {matchingCount === 1 ? "match" : "matches"}
        </span>
      </header>

      <Grid
        as="main"
        alignItems="center"
        columnGap="4"
        gridAutoFlow="dense"
        maxW="1600px"
        mx="auto"
        rowGap="2"
        templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }}
      >
        {orderedContainers.map((container, index) => (
          <GridItem
            as="article"
            colSpan={container.presetId === "6L" ? { base: 1, md: 2 } : 1}
            key={container.id}
            minW="0"
          >
            <LayeredContainer
              container={container}
              effect={effect}
              mode="card"
              priority={index < 3}
              visibleItemIds={
                normalizedQuery
                  ? visibleIdsByContainer.get(container.id)
                  : null
              }
            />
          </GridItem>
        ))}
      </Grid>
    </div>
  );
}

function itemMatches(item: PrototypeItem, terms: string[]) {
  const searchable =
    `${item.title} ${item.textPreview ?? ""} ${item.hasAudio ? "audio voice" : ""}`.toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

function EmptyState() {
  return (
    <Grid minH="100svh" placeItems="center" px="6" textAlign="center">
      <Text color="fg.muted" textStyle="sm">No containers in the inventory yet.</Text>
    </Grid>
  );
}

function VariantSwitcher({
  active,
  effect,
  onChange,
  onEffectChange,
}: {
  active: Variant;
  effect: RevealEffect;
  onChange: (variant: Variant) => void;
  onEffectChange: (effect: RevealEffect) => void;
}) {
  const activeIndex = variants.findIndex((variant) => variant.id === active);
  const cycle = useCallback(
    (direction: -1 | 1) => {
      const next =
        variants[
          (activeIndex + direction + variants.length) % variants.length
        ];
      onChange(next.id);
    },
    [activeIndex, onChange],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement &&
          event.target.isContentEditable)
      ) {
        return;
      }
      if (event.altKey && event.key === "ArrowLeft") cycle(-1);
      if (event.altKey && event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle]);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <nav
      aria-label="Prototype variant"
      className={styles.switcher}
    >
      <button
        aria-label="Previous variant"
        className={styles.switcherArrow}
        onClick={() => cycle(-1)}
        type="button"
      >
        <ArrowLeftIcon size={16} />
      </button>
      <span className={styles.switcherName}>
        {active.toUpperCase()} · {variants[activeIndex].label}
      </span>
      <button
        aria-label="Next variant"
        className={styles.switcherArrow}
        onClick={() => cycle(1)}
        type="button"
      >
        <ArrowRightIcon size={16} />
      </button>
      <span aria-hidden="true" className={styles.switcherDivider} />
      <button
        aria-label={`Use ${effect === "blur" ? "fade" : "blur"} reveal`}
        className={styles.switcherEffect}
        onClick={() => onEffectChange(effect === "blur" ? "fade" : "blur")}
        type="button"
      >
        {effect}
      </button>
    </nav>
  );
}

export function PrototypeClient({
  containers,
  initialEffect,
  initialVariant,
}: {
  containers: PrototypeContainer[];
  initialEffect: RevealEffect;
  initialVariant: Variant;
}) {
  const router = useRouter();
  const [effect, setEffect] = useState<RevealEffect>(initialEffect);
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const changeVariant = useCallback(
    (nextVariant: Variant) => {
      setVariant(nextVariant);
      window.scrollTo({ top: 0, behavior: "auto" });
      router.replace(`?variant=${nextVariant}&effect=${effect}`, {
        scroll: false,
      });
    },
    [effect, router],
  );
  const changeEffect = useCallback(
    (nextEffect: RevealEffect) => {
      setEffect(nextEffect);
      router.replace(`?variant=${variant}&effect=${nextEffect}`, {
        scroll: false,
      });
    },
    [router, variant],
  );

  return (
    <div className={styles.prototype}>
      {variant === "a" ? (
        <StackView containers={containers} effect={effect} />
      ) : null}
      {variant === "c" ? (
        <FocusView containers={containers} effect={effect} />
      ) : null}
      {variant === "d" ? (
        <BrowseView containers={containers} effect={effect} />
      ) : null}
      <VariantSwitcher
        active={variant}
        effect={effect}
        onChange={changeVariant}
        onEffectChange={changeEffect}
      />
    </div>
  );
}
