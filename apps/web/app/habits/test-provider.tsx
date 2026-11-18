import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { useState, type ReactNode } from "react";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";

// These interaction tests create a fresh window per scenario. Keep Emotion's
// stylesheet in that window instead of reusing a cache bound to a closed DOM.
export function HabitTestProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() =>
    createCache({ key: "habits-test", container: document.head }),
  );
  return (
    <CacheProvider value={cache}>
      <ChakraTestWrapper>{children}</ChakraTestWrapper>
    </CacheProvider>
  );
}
