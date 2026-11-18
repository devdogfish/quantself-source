"use client";

import { SpecialistInventoryError } from "../specialist-inventory-error";

export default function SupplementsInventoryError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SpecialistInventoryError category="Supplements" reset={reset} />;
}
