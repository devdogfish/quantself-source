// Layout preference constants. No "use client": the root layout (a server component) needs the boot script string.
export type Layout = "compact" | "center" | "side";
export const LAYOUTS: { value: Layout; label: string; description: string }[] = [
  { value: "compact", label: "Compact", description: "One top bar: logo, sections, actions" },
  { value: "center", label: "Centered", description: "Top bar with the sections centered" },
  { value: "side", label: "Sidebar", description: "Sections in a sidebar on the left" },
];
export const LAYOUT_KEY = "quantself.layout";
export const DEFAULT_LAYOUT: Layout = "compact";

export function applyLayoutAttribute(layout: Layout) {
  document.documentElement.dataset.layout = layout;
}

// Runs in <head> before first paint: puts the saved layout on <html data-layout>. globals.css picks the shell
// chrome from it (and from the viewport width), so the server HTML paints the right layout with no JS-driven jump.
export const LAYOUT_BOOT_SCRIPT = `try{var l=localStorage.getItem(${JSON.stringify(LAYOUT_KEY)});document.documentElement.dataset.layout=${JSON.stringify(LAYOUTS.map((x) => x.value))}.indexOf(l)>=0?l:${JSON.stringify(DEFAULT_LAYOUT)}}catch(e){document.documentElement.dataset.layout=${JSON.stringify(DEFAULT_LAYOUT)}}`;
