"use client";

// Budgeting area shell. The redesigned module pages (#175) render their own frame (PageHeader with the area
// tabs inside it); the existing pages (plan, affordability, import, receipts) keep their
// original column and loose tab row until they are moved onto the frame. The shared store keeps optimistic
// edits across both frames.
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Box, Stack } from "@chakra-ui/react";
import { AreaNav } from "@/components/shared/area-nav";
import { budgetingNav, modulePaths } from "./module/frame";
import { BudgetTransactionProvider } from "./module/transaction-store";
import { BudgetingStubStore } from "./module/stub-store";
import styles from "./layout.module.css";

export function BudgetingShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const framed = modulePaths.includes(pathname);
  return (
    <BudgetTransactionProvider>
      <BudgetingStubStore>
        {framed ? <Box as="main" minW="0">{children}</Box> : (
          <Stack className={styles.budgeting} as="main" mx="auto" w="full" minW="0" maxW="5xl" gap="6" px={{ base: "4", md: "8" }} py="6">
            <AreaNav items={budgetingNav} label="Budgeting" />
            {children}
          </Stack>
        )}
      </BudgetingStubStore>
    </BudgetTransactionProvider>
  );
}
