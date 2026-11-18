"use client";

import { Children, cloneElement, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from "react";
import { Button, type ButtonProps } from "@chakra-ui/react";

// "container": collapse to icon-only below the navbar container width (the bar sets containerName "navbar").
export const CompactNavActions = createContext<boolean | "container">(false);

// One visual treatment for the global toolbar actions: first child is the icon, the rest is the label.
// With `asChild`, the single child (for example a Next Link) holds the icon and label.
export function NavAction({ asChild, children: rawChildren, ...props }: ButtonProps) {
  const compact = useContext(CompactNavActions);
  const outer = Children.toArray(rawChildren);
  const link = asChild && isValidElement(outer[0]) ? (outer[0] as ReactElement<{ children?: ReactNode }>) : null;
  const children = link ? Children.toArray(link.props.children) : outer;
  const wrap = (content: ReactNode) => (link ? cloneElement(link, undefined, content) : content);
  const label = props["aria-label"] ?? children.filter((child) => typeof child === "string").join("").trim();
  const responsive = compact === "container";
  const iconOnly = compact === true;
  const content: ReactNode = iconOnly
    ? children[0]
    : responsive
      ? <>{children[0]}<span className="nav-label">{children.slice(1)}</span></>
      : children;
  const sizing: ButtonProps = iconOnly ? { px: "0", minW: "9", w: "9", gap: "0" } : { px: "3", gap: "2" };
  return <Button asChild={asChild} size="sm" h="9" variant="outline" colorPalette="gray"
    color="fg.muted" borderColor="border" bg="transparent" rounded="l2" fontWeight="medium"
    {...sizing}
    _hover={{ bg: "bg.muted", color: "fg" }} _expanded={{ bg: "bg.muted", color: "fg" }}
    css={{ "& > .nav-label": { display: "contents" }, "& svg": { width: "4", height: "4", flexShrink: 0 }, ...(responsive ? {
      "@container navbar (max-width: 1200px)": { paddingInline: "0", minWidth: "9", width: "9", gap: "0", "& .nav-label": { display: "none" } },
    } : {}) }}
    {...props}
    {...(iconOnly || responsive ? { "aria-label": label, title: label } : {})}>
    {wrap(content)}
  </Button>;
}
