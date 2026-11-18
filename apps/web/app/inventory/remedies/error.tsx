"use client";

import { SpecialistInventoryError } from "../specialist-inventory-error";

export default function RemediesInventoryError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SpecialistInventoryError category="Remedies" reset={reset} />;
}
