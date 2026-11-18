export type InventoryActionState = {
  status: "idle" | "success" | "error";
  message: string;
  uncertain?: boolean;
};

export type InventoryContainerFormOption = {
  id: string;
  referenceId: string;
  name: string;
  locationName: string | null;
  sizeLiters: number | null;
  visualPresetKey?: string;
};

export type InventoryContainerImageOption = {
  id: string;
  isDefault: boolean;
  name: string;
};

export type InventoryContainerActionState = InventoryActionState & {
  container?: InventoryContainerFormOption | null;
};

export const initialInventoryActionState: InventoryActionState = {
  status: "idle",
  message: "",
};

export const initialInventoryContainerActionState: InventoryContainerActionState = {
  status: "idle",
  message: "",
  container: null,
};
