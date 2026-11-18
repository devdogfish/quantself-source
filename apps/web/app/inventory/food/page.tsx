import { SpecialistInventoryPage } from "../specialist-inventory-page";

type FoodInventoryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export default function FoodInventoryPage({
  searchParams,
}: FoodInventoryPageProps) {
  const request = Promise.resolve(searchParams).then((params) => ({
    query: firstValue(params?.q),
  }));

  return SpecialistInventoryPage({
    category: "food",
    emptyLabel: "food",
    path: "/inventory/food",
    request,
    title: "Food inventory",
  });
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}
