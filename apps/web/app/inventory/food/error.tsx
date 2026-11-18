"use client";

import { SpecialistInventoryError } from "../specialist-inventory-error";

export default function FoodInventoryError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SpecialistInventoryError category="Food" reset={reset} />;
}
