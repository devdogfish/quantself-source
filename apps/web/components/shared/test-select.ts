// Test helper: pick an item from a Chakra Select (FilterSelect) by opening its trigger and clicking the option.
import { act } from "react";

export async function chooseOption(trigger: HTMLElement, label: string) {
  await act(async () => {
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const option = [...trigger.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.includes(label));
  if (!option) throw new Error(`No select option "${label}"`);
  await act(async () => {
    option.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
