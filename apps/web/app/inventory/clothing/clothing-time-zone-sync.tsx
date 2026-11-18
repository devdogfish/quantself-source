"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function ClothingTimeZoneSync() {
  const router = useRouter();

  useEffect(() => {
    const url = new URL(window.location.href);

    const requestedTimeZone = url.searchParams.get("timeZone");
    if (requestedTimeZone && isValidTimeZone(requestedTimeZone)) {
      return;
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) {
      return;
    }

    router.replace(
      clothingTimeZoneHref(url.pathname, url.searchParams, timeZone),
      { scroll: false },
    );
  }, [router]);

  return null;
}

function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function clothingTimeZoneHref(
  pathname: string,
  searchParams: URLSearchParams,
  timeZone: string,
): Route {
  const params = new URLSearchParams(searchParams);
  params.set("timeZone", timeZone);
  return `${pathname}?${params.toString()}` as Route;
}
