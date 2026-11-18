import {
  SpecialistInventoryLeadSkeleton,
  SpecialistInventoryLoading,
} from "../specialist-inventory-page";

export default function RemediesInventoryLoading() {
  return (
    <SpecialistInventoryLoading
      lead={
        <SpecialistInventoryLeadSkeleton titles={["Remedy timeline"]} />
      }
      title="Owned remedies"
    />
  );
}
