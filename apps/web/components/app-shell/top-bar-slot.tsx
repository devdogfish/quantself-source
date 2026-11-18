"use client";

// Top bar slot: a page can hand the app's top bar a second row of content (for example its filter bar).
// The page renders <ScrollSwapBar> where the content normally sits. Once that inline copy has scrolled under the top
// bar and the reader keeps scrolling down, the top bar's own content rolls up and out and the slot content rolls up
// in from below, like a slot machine. Scrolling up a little rolls it back. While the inline copy is still visible the
// regular top bar always shows. In the sidebar layout (no top bar) the slot appears as its own bar at the top.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Box, Container } from "@chakra-ui/react";

type Slot = { target: HTMLElement | null; shown: boolean };
const SlotState = createContext<Slot>({ target: null, shown: false });
const SlotControl = createContext<{ setTarget: (el: HTMLElement | null) => void; setShown: (shown: boolean) => void } | null>(null);

export function TopBarSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  const [control] = useState(() => ({ setTarget, setShown }));
  return <SlotControl.Provider value={control}><SlotState.Provider value={{ target, shown }}>{children}</SlotState.Provider></SlotControl.Provider>;
}

export const SWAP_TRANSITION = "transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease";

// True while the slot content replaces the top bar. The top bar uses this to roll its own content out.
export function useTopBarSlotShown() {
  return useContext(SlotState).shown;
}

// Mounted once by the app shell, right after the top bar: a 56px window pinned to the top of the main column.
export function TopBarSlotOutlet() {
  const control = useContext(SlotControl);
  const { shown } = useContext(SlotState);
  return (
    <Box position="sticky" top="0" h="0" zIndex="banner" data-top-bar-slot={shown ? "shown" : "hidden"}>
      <Box position="absolute" top="0" insetX="0" h="14" overflow="hidden" pointerEvents={shown ? "auto" : "none"}
        transition="background-color 200ms ease, border-color 200ms ease" borderBottomWidth="1px" borderColor="transparent"
        css={{
          // The sidebar layout has no top bar behind the slot, so the slot brings its own bar.
          "@media (min-width: 1000px)": { "html[data-layout='side'] &": shown ? { bg: "bg/90", backdropFilter: "blur(8px)", borderColor: "border" } : {} },
        }}>
        <Container maxW="7xl" h="full" display="flex" alignItems="center" transition={SWAP_TRANSITION}
          transform={shown ? "translateY(0)" : "translateY(100%)"} opacity={shown ? 1 : 0}
          ref={(el: HTMLDivElement | null) => control?.setTarget(el)} inert={!shown} aria-hidden={!shown} />
      </Box>
    </Box>
  );
}

// Page side: renders `children` inline and, while scrolled past, in the top bar slot.
export function ScrollSwapBar({ children }: { children: ReactNode }) {
  const control = useContext(SlotControl);
  const { target } = useContext(SlotState);
  const inline = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!control) return;
    let lastY = window.scrollY, down = false, frame = 0;
    const update = () => {
      frame = 0;
      const el = inline.current;
      if (!el) return;
      const y = window.scrollY;
      if (y > lastY + 2) down = true;
      else if (y < lastY - 2) down = false;
      lastY = y;
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-top")) || 0;
      const scrolledPast = el.getBoundingClientRect().bottom <= top;
      control.setShown(scrolledPast && down);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); control.setShown(false); };
  }, [control]);
  return <>
    <Box ref={inline} minW="0">{children}</Box>
    {target && createPortal(<Box w="full" minW="0">{children}</Box>, target)}
  </>;
}
