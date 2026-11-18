"use client";

import { Box, Flex, Grid, Text } from "@chakra-ui/react";
import { sceneBody, sceneSection } from "./container-layout";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import {
  ContainerVisual,
  type ContainerDebugRevealState,
} from "./container-visual";
import type { ContainerShelf } from "./types";

gsap.registerPlugin(ScrollTrigger, useGSAP);

export type ScrollStackProps = {
  containers: ContainerShelf[];
  debugBounds?: boolean;
  debugRevealState?: ContainerDebugRevealState;
  layoutSeed?: string;
  selectedId?: string;
  onActiveChange?: (id: string) => void;
};

const SECTION_SELECTOR = "[data-scroll-stack-section]";

export function ScrollStack({
  containers,
  debugBounds = false,
  debugRevealState = "auto",
  layoutSeed = "container-scene",
  selectedId,
  onActiveChange,
}: ScrollStackProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const lastReportedIdRef = useRef<string | undefined>(undefined);
  const onActiveChangeRef = useRef(onActiveChange);
  const containerIds = containers.map(({ id }) => id).join("\u001f");

  useEffect(() => {
    onActiveChangeRef.current = onActiveChange;
  }, [onActiveChange]);

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;

      const sections = gsap.utils.toArray<HTMLElement>(SECTION_SELECTOR, root);
      if (!sections.length) return;

      const reportActive = (id: string) => {
        if (lastReportedIdRef.current === id) return;
        lastReportedIdRef.current = id;
        onActiveChangeRef.current?.(id);
      };

      for (const section of sections) {
        const id = section.dataset.containerId;
        if (!id) continue;

        ScrollTrigger.create({
          trigger: section,
          start: "top center",
          end: "bottom center",
          onEnter: () => reportActive(id),
          onEnterBack: () => reportActive(id),
        });
      }

      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      if (!reducedMotion && sections.length > 1) {
        ScrollTrigger.create({
          trigger: root,
          start: "top top",
          end: "bottom bottom",
          snap: {
            delay: 0.08,
            directional: false,
            duration: { min: 0.18, max: 0.42 },
            ease: "power2.inOut",
            inertia: false,
            snapTo: 1 / (sections.length - 1),
          },
        });
      }

      const refreshFrame = window.requestAnimationFrame(() => {
        ScrollTrigger.refresh();
      });

      return () => {
        window.cancelAnimationFrame(refreshFrame);
      };
    },
    {
      dependencies: [containerIds],
      revertOnUpdate: true,
      scope: rootRef,
    },
  );

  useEffect(() => {
    if (!selectedId || selectedId === lastReportedIdRef.current) return;

    const section = sectionRefs.current.get(selectedId);
    if (!section) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    section.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [containerIds, selectedId]);

  if (!containers.length) {
    return (
      <Grid
        minH="100svh"
        placeItems="center"
        px="6"
        textAlign="center"
        color="black/60"
        textStyle="sm"
      >
        No containers found
      </Grid>
    );
  }

  return (
    <Box position="relative" asChild>
      <div ref={rootRef}>
        {containers.map((container, index) => (
          <Flex asChild {...sceneSection} key={container.id}>
            <section
              aria-label={`${container.name}, container ${index + 1} of ${containers.length}`}
              data-container-id={container.id}
              data-scroll-stack-section=""
              id={`container-${container.id}`}
              ref={(node) => {
                if (node) {
                  sectionRefs.current.set(container.id, node);
                } else {
                  sectionRefs.current.delete(container.id);
                }
              }}
            >
              <Text
                position="absolute"
                top="24"
                left="4"
                zIndex={10}
                fontFamily="mono"
                fontSize="10px"
                color="black/50"
                textTransform="uppercase"
                letterSpacing="0.18em"
                css={{
                  "@media (min-width: 40rem)": { top: "28", left: "8" },
                  "@media (min-width: 64rem)": { left: "11" },
                }}
              >
                {String(index + 1).padStart(2, "0")}
                <span aria-hidden="true"> / </span>
                {String(containers.length).padStart(2, "0")}
              </Text>

              <Flex {...sceneBody}>
                <ContainerVisual
                  container={container}
                  debugBounds={debugBounds}
                  debugRevealState={debugRevealState}
                  layoutSeed={layoutSeed}
                  mode="scroll"
                  priority={index === 0}
                />
              </Flex>
            </section>
          </Flex>
        ))}
      </div>
    </Box>
  );
}
