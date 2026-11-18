"use client";

import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { useServerInsertedHTML } from "next/navigation";
import { useState, type ReactNode } from "react";

export function EmotionRegistry({ children }: { children: ReactNode }) {
  const [{ cache, flush }] = useState(createStyleRegistry);
  useServerInsertedHTML(() => {
    const names = flush();
    if (names.length === 0) return null;
    const css = names.map((name) => cache.inserted[name]).join("");
    return (
      <style
        data-emotion={`${cache.key} ${names.join(" ")}`}
        dangerouslySetInnerHTML={{ __html: css }}
      />
    );
  });

  return <CacheProvider value={cache}>{children}</CacheProvider>;
}

function createStyleRegistry() {
  const cache = createCache({ key: "css" });
  cache.compat = true;
  // Keep server styles outside the hydration tree; Emotion can adopt them in
  // the browser without recreating the root and dropping its saved brand.
  let pending: string[] = [];
  if (typeof document === "undefined") {
    const insert = cache.insert;
    cache.insert = (...args) => {
      const name = args[1].name;
      if (cache.inserted[name] === undefined) pending.push(name);
      return insert(...args);
    };
  }
  return {
    cache,
    flush() {
      const names = pending;
      pending = [];
      return names;
    },
  };
}
