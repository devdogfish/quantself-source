import {
  SpecialistInventoryLeadSkeleton,
  SpecialistInventoryLoading,
} from "../specialist-inventory-page";

export default function ClothingInventoryLoading() {
  return (
    <SpecialistInventoryLoading
      lead={
        <SpecialistInventoryLeadSkeleton
          titles={["Wear today", "Upcoming events"]}
        />
      }
      title="Clothing wardrobe"
    />
  );
}
