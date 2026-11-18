import { Box, Button } from "@chakra-ui/react";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { inventorySecondaryButton } from "../../inventory-button-styles";

export function BoundsFrame({ children }: { children: ReactNode }) {
  return (
    <Box as="main" minH="calc(100vh - var(--shell-top, 0px))" bg="bg">
      <PageHeader
        title="Container bounds"
        actions={
          <Button asChild size="sm" {...inventorySecondaryButton}>
            <Link href="/inventory/containers" prefetch={false}>
              <ArrowLeftIcon aria-hidden="true" />
              Containers
            </Link>
          </Button>
        }
      />
      <PageBody>{children}</PageBody>
    </Box>
  );
}
