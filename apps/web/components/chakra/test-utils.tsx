import type { ReactNode } from "react";
import { Provider } from "./provider";

/** Wrap UI under test in the Chakra provider (system + next-themes). */
export function ChakraTestWrapper({ children }: { children: ReactNode }) {
  // Avoid next-themes transition timers crossing per-test happy-dom windows.
  return <Provider disableTransitionOnChange={false}>{children}</Provider>;
}
