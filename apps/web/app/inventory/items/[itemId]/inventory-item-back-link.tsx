import { Button } from "@chakra-ui/react";
import { itemSecondaryButton } from "./inventory-item-button-styles";
import { ArrowLeftIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

export function InventoryItemBackLink({ href }: { href: Route }) {
  return (
    <div>
      <Button {...itemSecondaryButton} asChild>
        <Link href={href}>
          <ArrowLeftIcon />
          Back
        </Link>
      </Button>
    </div>
  );
}
