export const containerPage = {
  position: "relative",
  minH: "100svh",
  bg: "white",
  color: "#171717",
} as const;

export const containerHeader = {
  pointerEvents: "none",
  position: "fixed",
  insetX: "0",
  top: "var(--shell-top, 0px)",
  zIndex: 40,
  px: "3",
  py: "3",
  pl: "16",
  css: { "@media (min-width: 40rem)": { px: "5", pl: "20" } },
} as const;

export const listHeader = {
  ...containerHeader,
  pl: "3",
  minH: "16",
  align: "start",
  justify: "space-between",
  gap: "2",
  css: {
    "@media (min-width: 40rem)": { px: "5", pl: "20", alignItems: "center" },
  },
} as const;

export const sceneSection = {
  position: "relative",
  h: "100svh",
  flexDirection: "column",
  px: "3",
  pt: "24",
  pb: "5",
  css: {
    "@media (min-width: 40rem)": { px: "7", pt: "28", pb: "7" },
    "@media (min-width: 64rem)": { px: "10" },
  },
} as const;

export const sceneBody = {
  mx: "auto",
  minH: "0",
  w: "full",
  maxW: "1600px",
  flex: "1",
  align: "center",
  justify: "center",
} as const;

export const controlSurface = {
  borderWidth: "1px",
  borderColor: "border",
  borderRadius: "l2",
  bg: "bg",
  color: "fg",
} as const;

export const detailAction = {
  size: "sm",
  borderRadius: "l2",
  gap: "2",
  pointerEvents: "auto",
  h: "8",
  px: "2.5",
  css: { "& svg": { boxSize: "4" } },
} as const;
