import { SpecialistInventoryPage } from "../specialist-inventory-page";

type SupplementsInventoryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export default function SupplementsInventoryPage({
  searchParams,
}: SupplementsInventoryPageProps) {
  const request = Promise.resolve(searchParams).then((params) => ({
    query: firstValue(params?.q),
  }));

  return SpecialistInventoryPage({
    category: "supplement",
    emptyLabel: "supplement",
    path: "/inventory/supplements",
    request,
    title: "Supplements inventory",
  });
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}
