"use client";
import { Box, chakra } from "@chakra-ui/react";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CompassIcon,
  LifeBuoyIcon,
  ScanLineIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, type ReactNode } from "react";
import { PageHeader } from "@/components/shared/page-layout";
import { prototypeStyles as styles } from "./habits-prototype.styles";

import type { Variant } from "./habits-prototype-variant";
export type Section = "today" | "weekly" | "system" | "playbook";
const variants = ["A", "B", "C"] as const;
const names = { A: "Cue map", B: "Field notes", C: "Console" };
const navigation = [
  { section: "today", label: "Today", Icon: CompassIcon },
  { section: "weekly", label: "Weekly", Icon: ScanLineIcon },
  { section: "system", label: "My system", Icon: BookOpenIcon },
  { section: "playbook", label: "Urge playbook", Icon: LifeBuoyIcon },
] as const;

export function prototypeHref(variant: Variant, section: Section): Route {
  return (
    section === "weekly"
      ? `/habits/summary`
      : `/habits?variant=${variant}${section === "today" ? "" : `&section=${section}`}`
  ) as Route;
}

export function PrototypeShell({
  variant,
  section,
  children,
}: {
  variant: Variant;
  section: Section;
  children: ReactNode;
}) {
  const router = useRouter();
  const cycle = useCallback(
    (direction: number) => {
      const next =
        variants[
          (variants.indexOf(variant) + direction + variants.length) %
            variants.length
        ]!;
      const url = new URL(window.location.href);
      url.searchParams.set("variant", next);
      router.replace((url.pathname + url.search + url.hash) as Route, {
        scroll: false,
      });
    },
    [variant, router],
  );

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        target?.closest(
          "input, textarea, select, [contenteditable], [role=slider], [role=region], summary",
        )
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cycle(event.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [cycle]);

  function cycleHref(direction: number) {
    const next =
      variants[
        (variants.indexOf(variant) + direction + variants.length) %
          variants.length
      ]!;
    return prototypeHref(next, section);
  }

  function switchVariant(
    event: React.MouseEvent<HTMLAnchorElement>,
    direction: number,
  ) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    event.preventDefault();
    cycle(direction);
  }

  return (
    <chakra.main css={styles.shell} data-variant={variant}>
      <PageHeader
        title="Habits"
        description={
          process.env.NEXT_PUBLIC_QUANTSELF_HABITS_FIXTURE === "1"
            ? "Sample data · local only"
            : "Design preview · local drafts"
        }
        nav={
          <chakra.nav css={styles.nav} aria-label="Habit workspace">
            {navigation.map(({ section: linkSection, label, Icon }) => (
              <Link
                key={linkSection}
                href={prototypeHref(variant, linkSection)}
                aria-current={section === linkSection ? "page" : undefined}
              >
                <Icon aria-hidden="true" size={17} /> {label}
              </Link>
            ))}
          </chakra.nav>
        }
      />
      <Box css={styles.frame}>{children}</Box>
      <chakra.nav css={styles.switcher} aria-label="Prototype variations">
        <Link
          href={cycleHref(-1)}
          onClick={(event) => switchVariant(event, -1)}
          aria-label="Previous variation"
        >
          <ArrowLeftIcon size={16} />
        </Link>
        <span aria-live="polite">
          <small>{variant} / C</small> {names[variant]}
        </span>
        <Link
          href={cycleHref(1)}
          onClick={(event) => switchVariant(event, 1)}
          aria-label="Next variation"
        >
          <ArrowRightIcon size={16} />
        </Link>
      </chakra.nav>
    </chakra.main>
  );
}
