import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  InventoryCaptureAction,
  InventoryCreateContainerAction,
  InventoryCaptureSessionDefaults,
} from "./capture-session-card";

const browserCaptureCalls: Array<Record<string, unknown>> = [];
const browserCaptureFiles: File[][] = [];
const browserCaptureKeys: string[] = [];
let browserCaptureFailures = 0;

mock.module("@/lib/quantself-api-browser", () => ({
  captureInventoryItemFromBrowser: async (
    input: Record<string, unknown>,
    files: File[],
    options?: { idempotencyKey?: string },
  ) => {
    browserCaptureCalls.push(input);
    browserCaptureFiles.push(files);
    browserCaptureKeys.push(options?.idempotencyKey ?? "");

    if (browserCaptureFailures > 0) {
      browserCaptureFailures -= 1;
      throw new Error("Capture response was lost.");
    }

    return {
      media: [],
      preprocessingJob: { id: "job-1", status: "QUEUED" },
      item: {
        id: "item-browser-1",
      },
    };
  },
  inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
    `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
  inventoryItemMediaFilesSignature: (files: File[]) =>
    JSON.stringify(
      files.map(({ lastModified, name, size, type }) => ({
        lastModified,
        name,
        size,
        type,
      })),
    ),
  deleteInventoryItemMediaFromBrowser: async () => undefined,
  reorderInventoryItemImagesFromBrowser: async () => undefined,
}));

describe("inventory capture session card", () => {
  let InventoryCaptureSessionCard: typeof import("./capture-session-card").InventoryCaptureSessionCard;
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ InventoryCaptureSessionCard } = await import("./capture-session-card"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    // Let overlay focus restoration finish before replacing the DOM.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    browserCaptureCalls.length = 0;
    browserCaptureFiles.length = 0;
    browserCaptureKeys.length = 0;
    browserCaptureFailures = 0;
    container.remove();
    cleanupGlobals?.();
    cleanupGlobals = null;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  test("keeps manual inventory fields collapsed until Details is opened", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async () => ({
              message: "",
              status: "idle",
            })}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    expect(container.textContent).toContain("Photos");
    expect(container.textContent).toContain("Audio notes");
    expect(container.textContent).toContain("Typed capture text");
    expect(container.textContent).toContain("Take photo");
    expect(container.textContent).toContain("Record audio");
    expect(container.textContent).toContain("Upload photos");
    expect(container.textContent).toContain("Upload audio");
    expect(container.textContent).toContain("Container");
    expect(container.textContent).not.toContain("Filter containers");
    expect(container.textContent).not.toContain("Container override");
    expect(container.textContent).not.toContain("Session origin");
    expect(container.textContent).not.toContain("source facts first");
    expect(
      container.querySelector<HTMLInputElement>('input[name="images"]')?.accept,
    ).toContain(".jpg");
    expect(
      container.querySelector<HTMLInputElement>('input[name="audioNotes"]')
        ?.accept,
    ).toContain(".mp3");
    const containerPicker = container.querySelector<HTMLInputElement>(
      'input[role="combobox"][aria-haspopup="listbox"]',
    );

    if (!containerPicker) {
      throw new Error("Missing container picker");
    }

    expect(containerPicker.tagName).toBe("INPUT");
    expect(containerPicker.value).toBe("Blue bin 4 (BIN-0004)");
    expect(container.querySelector('form > p[aria-live="polite"]')).toBeNull();
    expect(
      document.body.querySelectorAll('input[placeholder="Search containers"]'),
    ).toHaveLength(1);

    await act(async () => {
      containerPicker.click();
      await waitForAnimationFrame();
    });

    expect(document.body.textContent).toContain("No container");
    expect(document.body.textContent).toContain("Create container");
    expect(
      findButtonByText(document.body, "No container").getAttribute("role"),
    ).toBe("option");
    expect(document.body.textContent).not.toContain(
      "Leave this capture unplaced",
    );
    expect(document.body.textContent).not.toContain("Garage shelf A");

    await act(async () => {
      setInputValue(containerPicker, "45 L");
    });

    expect(document.body.textContent).toContain("Blue bin 4 (BIN-0004)");

    await act(async () => {
      findButtonByText(document.body, "Blue bin 4 (BIN-0004)").click();
    });

    expect(getHiddenContainerValue(container)).toBe("container-blue-bin");
    expect(document.body.textContent).not.toContain("Create container");

    await act(async () => {
      containerPicker.click();
      await waitForAnimationFrame();
    });

    await act(async () => {
      setInputValue(containerPicker, "Camera cube");
    });

    expect(document.body.textContent).toContain("No matching containers.");
    expect(document.body.textContent).toContain('Create "Camera cube"');

    const detailsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="inventory-capture-details"]',
    );

    if (!detailsButton) {
      throw new Error("Missing details toggle");
    }

    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Category");
    expect(container.textContent).not.toContain("Acquisition source");
    expect(container.textContent).not.toContain("Estimated value");
    expect(container.textContent).not.toContain("Origin override");
    expect(container.textContent).not.toContain("Destination override");

    await act(async () => {
      detailsButton.click();
    });

    expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Kind");
    expect(container.textContent).toContain("Category");
    expect(container.textContent).toContain("Acquisition source");
    expect(container.textContent).toContain("Estimated value");
    expect(
      container.querySelector('input[name="estimatedValue"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Origin override");
    expect(container.textContent).not.toContain("Destination override");
    expect(container.textContent).toContain("Item note");
  });

  test("shows detail select labels while submitting uppercase enum values", async () => {
    const submissions: FormData[] = [];
    const captureAction: InventoryCaptureAction = async (_state, formData) => {
      submissions.push(formData);

      return {
        message: "Capture saved. Inventory preprocessing queued.",
        status: "success",
      };
    };

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={captureAction}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    await act(async () => {
      findButtonByText(container, "Details").click();
    });

    expect(getSelectTriggerText(container, "inventory-kind")).toBe(
      "Item group",
    );
    expect(getSelectTriggerText(container, "inventory-status")).toBe("Unsure");
    expect(getSelectTriggerText(container, "inventory-importance")).toBe(
      "Medium",
    );

    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!submitButton) {
      throw new Error("Missing submit button");
    }

    await act(async () => {
      submitButton.click();
    });

    expect(submissions[0]?.get("kind")).toBe("GROUP");
    expect(submissions[0]?.get("status")).toBe("UNSURE");
    expect(submissions[0]?.get("importance")).toBe("MEDIUM");
  });

  test("focuses media actions from section labels without activating them", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async () => ({
              message: "",
              status: "idle",
            })}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    const imageInput = container.querySelector<HTMLInputElement>(
      'input[name="images"]',
    );
    const audioInput = container.querySelector<HTMLInputElement>(
      'input[name="audioNotes"]',
    );
    const imageLabel = findLabelByText(container, "Photos");
    const audioLabel = findLabelByText(container, "Audio notes");
    const takePhotoButton = findButtonByText(container, "Take photo");
    const uploadPhotosButton = findButtonByText(container, "Upload photos");
    const recordAudioButton = findButtonByText(container, "Record audio");
    const uploadAudioButton = findButtonByText(container, "Upload audio");

    if (!imageInput || !audioInput || !imageLabel || !audioLabel) {
      throw new Error("Missing media labels or inputs");
    }

    expect(imageLabel.id).not.toBe("");
    expect(audioLabel.id).not.toBe("");
    expect(imageInput.getAttribute("aria-labelledby")).toBe(imageLabel.id);
    expect(audioInput.getAttribute("aria-labelledby")).toBe(audioLabel.id);

    let imageClicks = 0;
    let audioClicks = 0;
    let takePhotoClicks = 0;
    let recordAudioClicks = 0;
    imageInput.addEventListener("click", () => {
      imageClicks += 1;
    });
    audioInput.addEventListener("click", () => {
      audioClicks += 1;
    });
    takePhotoButton.addEventListener("click", () => {
      takePhotoClicks += 1;
    });
    recordAudioButton.addEventListener("click", () => {
      recordAudioClicks += 1;
    });

    await act(async () => {
      imageLabel.click();
    });

    expect(document.activeElement === takePhotoButton).toBe(true);
    expect(imageClicks).toBe(0);
    expect(takePhotoClicks).toBe(0);

    await act(async () => {
      audioLabel.click();
    });

    expect(document.activeElement === recordAudioButton).toBe(true);
    expect(audioClicks).toBe(0);
    expect(recordAudioClicks).toBe(0);

    await act(async () => {
      uploadPhotosButton.click();
    });

    expect(document.activeElement === uploadPhotosButton).toBe(true);
    expect(imageClicks).toBe(1);

    await act(async () => {
      uploadAudioButton.click();
    });

    expect(document.activeElement === uploadAudioButton).toBe(true);
    expect(audioClicks).toBe(1);
  });

  test("keeps capture inputs usable while awaiting confirmation and preserves the draft on error", async () => {
    const submissions: FormData[] = [];
    const { promise: response, resolve } =
      Promise.withResolvers<Awaited<ReturnType<InventoryCaptureAction>>>();
    const captureAction: InventoryCaptureAction = async (_state, formData) => {
      submissions.push(formData);
      return response;
    };

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={captureAction}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    const captureText = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="captureText"]',
    );
    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!captureText || !submitButton) {
      throw new Error("Missing capture form controls");
    }

    await act(async () => {
      captureText.value = "Passport pouch with charger and pen.";
      captureText.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton.click();
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.get("captureSessionId")).toBe("session-1");
    expect(submissions[0]?.get("containerId")).toBe("container-blue-bin");
    expect(submissions[0]?.get("captureText")).toBe(
      "Passport pouch with charger and pen.",
    );
    expect(submissions[0]?.getAll("images")).toHaveLength(0);
    expect(submissions[0]?.getAll("audioNotes")).toHaveLength(0);
    expect(submitButton.disabled).toBe(true);
    expect(submitButton.getAttribute("aria-busy")).toBe("true");
    expect(captureText.disabled).toBe(false);

    await act(async () => {
      captureText.value = "Updated passport pouch details.";
      captureText.dispatchEvent(new Event("input", { bubbles: true }));
      findButtonByText(container, "Details").click();
    });

    expect(captureText.value).toBe("Updated passport pouch details.");
    expect(
      findButtonByText(container, "Details").getAttribute("aria-expanded"),
    ).toBe("true");

    await act(async () => {
      resolve({ message: "Could not save capture.", status: "error" });
    });

    expect(submitButton.disabled).toBe(false);
    expect(captureText.value).toBe("Updated passport pouch details.");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Could not save capture.",
    );
  });

  test("preselects specialist category and captures at a direct location", async () => {
    const submissions: FormData[] = [];

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async (_state, formData) => {
              submissions.push(formData);
              return { message: "Capture saved.", status: "success" };
            }}
            initialCategory="food"
            locations={[{ id: "location-pantry", name: "Pantry" }]}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    await act(async () => {
      findButtonByText(container, "No direct location").click();
      await waitForAnimationFrame();
    });
    const pantryOption = [
      ...document.body.querySelectorAll('[role="option"]'),
    ].find((option) => option.textContent?.trim() === "Pantry") as
      HTMLElement | undefined;

    if (!pantryOption) {
      throw new Error("Missing Pantry location option");
    }

    await act(async () => {
      pantryOption.click();
    });
    await act(async () => {
      findButtonByText(container, "Details").click();
    });

    expect(getHiddenContainerValue(container)).toBe("__none");
    expect(
      container.querySelector<HTMLInputElement>('input[name="locationId"]')
        ?.value,
    ).toBe("location-pantry");
    expect(getSelectTriggerText(container, "inventory-category")).toBe("Food");

    const captureText = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="captureText"]',
    );
    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!captureText || !submitButton) {
      throw new Error("Missing capture form controls");
    }

    await act(async () => {
      captureText.value = "Oat milk";
      captureText.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton.click();
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.get("category")).toBe("food");
    expect(submissions[0]?.get("containerId")).toBe("__none");
    expect(submissions[0]?.get("locationId")).toBe("location-pantry");
  });

  test("defaults to creating a new item even when search suggests a match", async () => {
    const submissions: FormData[] = [];

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async (_state, formData) => {
              submissions.push(formData);
              return { message: "Added 1 · Total 2", status: "success" };
            }}
            itemCandidates={buildItemCandidates()}
            session={buildSession()}
            suggestedItemId="item-duo"
          />
        </ChakraTestWrapper>,
      );
    });

    expect(container.textContent).toContain("Photos");
    expect(container.textContent).toContain("Typed capture text");
    expect(container.textContent).toContain("Create item");
    expect(
      container.querySelector<HTMLInputElement>('input[name="captureMode"]')
        ?.value,
    ).toBe("new");
    const modeGroup = container.querySelector(
      '[role="radiogroup"][aria-label="Capture path"]',
    );
    const createMode = getCaptureModeInput(container, "new");
    const existingMode = getCaptureModeInput(container, "existing");
    expect(modeGroup?.contains(createMode)).toBe(true);
    expect(modeGroup?.contains(existingMode)).toBe(true);
    expect(createMode.labels?.[0]?.textContent).toBe("Create new item");
    expect(existingMode.labels?.[0]?.textContent).toBe("Add units to existing");
    expect(createMode.checked).toBe(true);

    await act(async () => {
      existingMode.click();
    });

    expect(existingMode.checked).toBe(true);

    expect(container.textContent).toContain("Life Solution DUO");
    expect(container.textContent).toContain("R1");
    expect(container.textContent).not.toContain("Total 1");
    expect(container.textContent).not.toContain("R1 1");
    expect(container.textContent).not.toContain("Photos");

    await act(async () => {
      findButtonByText(container, "Add units to this item").click();
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.get("captureMode")).toBe("existing");
    expect(submissions[0]?.get("existingItemId")).toBe("item-duo");
    expect(submissions[0]?.get("quantity")).toBe("1");
    expect(submissions[0]?.get("containerId")).toBe("container-blue-bin");
    expect(submissions[0]?.getAll("images")).toHaveLength(0);
  });

  test("requires confirmation for a suggestion and offers an explicit separate-item escape", async () => {
    const submissions: FormData[] = [];

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async (_state, formData) => {
              submissions.push(formData);
              return { message: "", status: "success" };
            }}
            itemCandidates={buildItemCandidates()}
            session={buildSession()}
            suggestedItemId="item-duo"
          />
        </ChakraTestWrapper>,
      );
    });

    expect(submissions).toHaveLength(0);

    await act(async () => {
      getCaptureModeInput(container, "existing").click();
    });

    await act(async () => {
      findButtonByText(container, "Create separate item").click();
    });

    expect(container.textContent).toContain("Photos");
    expect(container.textContent).toContain("Typed capture text");
    expect(container.textContent).toContain("Create item");
    expect(
      container.querySelector<HTMLInputElement>('input[name="captureMode"]')
        ?.value,
    ).toBe("new");
    expect(submissions).toHaveLength(0);
  });

  test("handles an empty saved-container list with No container and create", async () => {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={[]}
            captureAction={async () => ({
              message: "",
              status: "idle",
            })}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={{
              ...buildSession(),
              container: null,
              containerLabel: null,
            }}
          />
        </ChakraTestWrapper>,
      );
    });

    const containerPicker = getContainerPicker(container);

    expect(containerPicker.value).toBe("No container");

    await act(async () => {
      containerPicker.click();
      await waitForAnimationFrame();
    });

    expect(document.body.textContent).toContain("No container");
    expect(document.body.textContent).toContain("No saved containers.");
    expect(document.body.textContent).toContain("Create container");
  });

  test("selects No container and submits the unplaced sentinel", async () => {
    const submissions: FormData[] = [];
    const captureAction: InventoryCaptureAction = async (_state, formData) => {
      submissions.push(formData);

      return {
        message: "Capture saved. Inventory preprocessing queued.",
        status: "success",
      };
    };

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={captureAction}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    const containerPicker = getContainerPicker(container);

    await act(async () => {
      containerPicker.click();
      await waitForAnimationFrame();
    });
    await act(async () => {
      findButtonByText(document.body, "No container").click();
    });

    expect(getHiddenContainerValue(container)).toBe("__none");
    expect(containerPicker.value).toBe("No container (Travel drawer)");
    expect(document.body.textContent).not.toContain("Create container");

    const captureText = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="captureText"]',
    );
    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!captureText || !submitButton) {
      throw new Error("Missing capture form controls");
    }

    await act(async () => {
      captureText.value = "Loose adapter for later sorting.";
      captureText.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton.click();
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.get("containerId")).toBe("__none");
  });

  test("creates a container from the query and selects it", async () => {
    const createdContainer = {
      id: "container-camera-cube",
      locationName: "Office cabinet",
      name: "Camera cube",
      referenceId: "CAM-0001",
      sizeLiters: 12,
      visualPresetKey: "39L",
    };
    const createContainerAction: InventoryCreateContainerAction = async (
      _state,
      formData,
    ) => ({
      container: {
        ...createdContainer,
        name: String(formData.get("containerName")),
      },
      message: "Container created.",
      status: "success",
    });

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async () => ({
              message: "",
              status: "idle",
            })}
            createContainerAction={createContainerAction}
            session={buildSession()}
            visualPresets={[
              {
                id: "39L",
                isDefault: true,
                name: "39L",
              },
            ]}
          />
        </ChakraTestWrapper>,
      );
    });

    const containerPicker = getContainerPicker(container);

    await act(async () => {
      containerPicker.click();
      setInputValue(containerPicker, "Camera cube");
    });
    await act(async () => {
      findButtonByText(document.body, 'Create "Camera cube"').click();
      await Promise.resolve();
      await waitForAnimationFrame();
      await waitForAnimationFrame();
    });

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[name="containerName"]',
    );

    if (!nameInput) {
      throw new Error("Missing create-container name input");
    }

    expect(nameInput.value).toBe("Camera cube");
    expect(document.body.textContent).toContain(
      "Add a bin, tote, drawer, or box.",
    );

    const sheetForm = nameInput.closest("form");
    const submitButton = sheetForm?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!submitButton) {
      throw new Error("Missing create-container submit button");
    }

    await act(async () => {
      submitButton.click();
      await Promise.resolve();
    });

    expect(getHiddenContainerValue(container)).toBe("container-camera-cube");
    expect(containerPicker.value).toBe("Camera cube (CAM-0001)");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      containerPicker.click();
      setInputValue(containerPicker, "Travel pouch");
    });
    await act(async () => {
      findButtonByText(document.body, 'Create "Travel pouch"').click();
      await waitForAnimationFrame();
    });
    const reopenedName = document.body.querySelector<HTMLInputElement>(
      'input[name="containerName"]',
    );
    expect(reopenedName?.value).toBe("Travel pouch");
    expect(
      document.body.querySelector('[role="dialog"]')?.textContent,
    ).not.toContain("Container created.");
    await act(async () => {
      findButtonByText(document.body, "Cancel").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(getHiddenContainerValue(container)).toBe("container-camera-cube");
  });

  test("clears uploaded media after success without losing capture defaults", async () => {
    const submissions: FormData[] = [];
    const captureAction: InventoryCaptureAction = async (_state, formData) => {
      submissions.push(formData);

      return {
        message: "Capture saved. Inventory preprocessing queued.",
        status: "success",
      };
    };

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={captureAction}
            createContainerAction={async () => ({
              container: null,
              message: "",
              status: "idle",
            })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    const imageInput = container.querySelector<HTMLInputElement>(
      'input[name="images"]',
    );
    const audioInput = container.querySelector<HTMLInputElement>(
      'input[name="audioNotes"]',
    );
    const captureText = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="captureText"]',
    );
    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!imageInput || !audioInput || !captureText || !submitButton) {
      throw new Error("Missing capture form controls");
    }

    await act(async () => {
      imageInput.files = [
        new File(["photo"], "passport.jpg", { type: "image/jpeg" }),
      ] as unknown as FileList;
      imageInput.dispatchEvent(new Event("change", { bubbles: true }));
      audioInput.files = [
        new File(["audio"], "passport.ogg", { type: "audio/ogg" }),
      ] as unknown as FileList;
      audioInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("passport.jpg");
    expect(container.textContent).toContain("passport.ogg");
    expect(imageInput.files).toHaveLength(0);
    expect(audioInput.files).toHaveLength(0);

    await act(async () => {
      captureText.value = "First capture.";
      captureText.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton.click();
    });

    expect(submissions).toHaveLength(0);
    expect(browserCaptureCalls).toHaveLength(1);
    expect(browserCaptureCalls[0]?.captureSessionId).toBe("session-1");
    expect(browserCaptureCalls[0]?.containerId).toBe("container-blue-bin");
    expect(browserCaptureCalls[0]?.captureText).toBe("First capture.");
    expect(browserCaptureFiles[0]?.map((file) => file.name)).toEqual([
      "passport.jpg",
      "passport.ogg",
    ]);
    expect(imageInput.files).toHaveLength(0);
    expect(audioInput.files).toHaveLength(0);
    expect(getHiddenContainerValue(container)).toBe("container-blue-bin");

    await act(async () => {
      captureText.value = "Second capture.";
      captureText.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton.click();
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.getAll("images")).toHaveLength(0);
    expect(submissions[0]?.getAll("audioNotes")).toHaveLength(0);
    expect(submissions[0]?.get("captureSessionId")).toBe("session-1");
    expect(submissions[0]?.get("containerId")).toBe("container-blue-bin");
    expect(browserCaptureCalls).toHaveLength(1);
  });

  test("records audio in-browser and submits it as an audio note", async () => {
    const cleanupRecordingMocks = installAudioRecordingMocks();
    const submissions: FormData[] = [];
    const captureAction: InventoryCaptureAction = async (_state, formData) => {
      submissions.push(formData);

      return {
        message: "Capture saved. Inventory preprocessing queued.",
        status: "success",
      };
    };

    try {
      await act(async () => {
        root.render(
          <ChakraTestWrapper>
            <InventoryCaptureSessionCard
              containers={buildContainers()}
              captureAction={captureAction}
              createContainerAction={async () => ({
                container: null,
                message: "",
                status: "idle",
              })}
              session={buildSession()}
            />
          </ChakraTestWrapper>,
        );
      });

      const recordButton = findButtonByText(container, "Record");

      await act(async () => {
        recordButton.click();
        await Promise.resolve();
      });

      const stopButton = findButtonByText(container, "Stop");

      await act(async () => {
        stopButton.click();
      });

      const submitButton = container.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );

      if (!submitButton) {
        throw new Error("Missing submit button");
      }

      await act(async () => {
        submitButton.click();
      });

      expect(submissions).toHaveLength(0);
      expect(browserCaptureCalls).toHaveLength(1);
      expect(browserCaptureCalls[0]?.captureText).toBeNull();
      expect(browserCaptureFiles[0]).toHaveLength(1);
      expect(browserCaptureFiles[0]?.[0]).toBeInstanceOf(File);
      expect(browserCaptureFiles[0]?.[0]?.name).toEndWith(".webm");
      expect(container.textContent).toContain(
        "Capture saved. Inventory preprocessing queued.",
      );
    } finally {
      cleanupRecordingMocks();
    }
  });

  test("retries a lost capture response with one stable key", async () => {
    browserCaptureFailures = 1;

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryCaptureSessionCard
            containers={buildContainers()}
            captureAction={async () => ({ message: "", status: "idle" })}
            session={buildSession()}
          />
        </ChakraTestWrapper>,
      );
    });

    const imageInput = container.querySelector<HTMLInputElement>(
      'input[name="images"]',
    );
    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );

    if (!imageInput || !submitButton) {
      throw new Error("Missing capture controls");
    }

    await act(async () => {
      imageInput.files = [
        new File(["photo"], "retry.jpg", { type: "image/jpeg" }),
      ] as unknown as FileList;
      imageInput.dispatchEvent(new Event("change", { bubbles: true }));
      submitButton.click();
    });

    expect(container.textContent).toContain("Capture response was lost.");

    await act(async () => {
      submitButton.click();
    });

    expect(browserCaptureCalls).toHaveLength(2);
    expect(browserCaptureKeys[0]).not.toBe("");
    expect(browserCaptureKeys[1]).toBe(browserCaptureKeys[0]);
    expect(browserCaptureFiles[0]?.[0]?.name).toBe("retry.jpg");
    expect(browserCaptureFiles[1]?.[0]?.name).toBe("retry.jpg");
    expect(container.textContent).toContain(
      "Capture saved. Inventory preprocessing queued.",
    );
  });
});

function buildSession(): InventoryCaptureSessionDefaults {
  return {
    container: buildContainers()[0] ?? null,
    containerLabel: "Travel drawer",
    destinationLocation: "Office cabinet",
    id: "session-1",
    label: "Apartment reset",
    note: "Keep fast capture moving.",
    originRoom: "Entryway floor",
  };
}

function buildContainers() {
  return [
    {
      id: "container-blue-bin",
      locationName: "Garage shelf A",
      name: "Blue bin 4",
      referenceId: "BIN-0004",
      sizeLiters: 45,
    },
  ];
}

function buildItemCandidates() {
  return [
    {
      id: "item-duo",
      imageId: "image-duo",
      placements: [{ label: "R1", quantity: 1 }],
      title: "Life Solution DUO",
      totalQuantity: 1,
    },
  ];
}

function registerDomGlobals(): () => void {
  const window = new Window();
  let objectUrlIndex = 0;

  Object.defineProperties(window.URL, {
    createObjectURL: {
      configurable: true,
      value: () => `blob:inventory-test-${objectUrlIndex++}`,
    },
    revokeObjectURL: {
      configurable: true,
      value: () => undefined,
    },
  });
  const previous = {
    document: globalThis.document,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    NodeFilter: globalThis.NodeFilter,
    MutationObserver: globalThis.MutationObserver,
    CustomEvent: globalThis.CustomEvent,
    DocumentFragment: globalThis.DocumentFragment,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    File: globalThis.File,
    FormData: globalThis.FormData,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    MouseEvent: globalThis.MouseEvent,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    URL: globalThis.URL,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: window.document,
    HTMLSelectElement: window.HTMLSelectElement,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    File: window.File,
    FormData: window.FormData,
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MouseEvent: window.MouseEvent,
    navigator: window.navigator,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    URL: window.URL,
    window,
  });

  return () => {
    Object.assign(globalThis, previous);
  };
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}

function findButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const button = buttons.find((entry) => entry.textContent?.includes(text));

  if (!button) {
    throw new Error(`Missing ${text} button`);
  }

  return button;
}

function findLabelByText(
  container: HTMLElement,
  text: string,
): HTMLLabelElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLLabelElement>("label")).find(
      (entry) => entry.textContent?.trim() === text,
    ) ?? null
  );
}

function getCaptureModeInput(
  container: HTMLElement,
  mode: "new" | "existing",
): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `[aria-label="Capture path"] input[type="radio"][value="${mode}"]`,
  );

  if (!input) {
    throw new Error(`Missing ${mode} capture radio`);
  }

  return input;
}

function getContainerPicker(container: HTMLElement): HTMLInputElement {
  const picker = container.querySelector<HTMLInputElement>(
    'input[role="combobox"][aria-haspopup="listbox"]',
  );

  if (!picker) {
    throw new Error("Missing container picker");
  }

  return picker;
}

function getHiddenContainerValue(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLInputElement>('input[name="containerId"]')
    ?.value;
}

function getSelectTriggerText(container: HTMLElement, id: string): string {
  const trigger = container.querySelector<HTMLButtonElement>(`#${id}`);

  if (!trigger) {
    throw new Error(`Missing ${id} select`);
  }

  return trigger.textContent?.trim() ?? "";
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function installAudioRecordingMocks(): () => void {
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousMediaDevices = navigator.mediaDevices;
  const previousMediaRecorder = globalThis.MediaRecorder;
  const previousRevokeObjectUrl = URL.revokeObjectURL;

  class MockMediaRecorder extends EventTarget {
    mimeType = "audio/webm";
    state: RecordingState = "inactive";

    constructor() {
      super();
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";

      const dataEvent = new Event("dataavailable") as Event & { data: Blob };
      Object.defineProperty(dataEvent, "data", {
        value: new Blob(["voice"], { type: this.mimeType }),
      });

      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event("stop"));
    }
  }

  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: MockMediaRecorder,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () =>
        ({
          getTracks: () => [{ stop: () => undefined }],
        }) as MediaStream,
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:recorded-audio",
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });

  return () => {
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: previousMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: previousMediaDevices,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: previousCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: previousRevokeObjectUrl,
    });
  };
}
