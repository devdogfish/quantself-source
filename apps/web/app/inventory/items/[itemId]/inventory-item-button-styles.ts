import { inventorySecondaryButton } from "../../inventory-button-styles";

export const itemButton = {
  size: "sm",
  rounded: "l2",
} as const;

export const itemSecondaryButton = {
  ...itemButton,
  ...inventorySecondaryButton,
} as const;

export const itemDestructiveButton = {
  ...itemButton,
  variant: "subtle",
  colorPalette: "red",
} as const;
