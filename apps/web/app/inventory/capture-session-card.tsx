"use client";

import {
  Box,
  Button,
  Collapsible,
  Field,
  Flex,
  Grid,
  Heading,
  IconButton,
  Input,
  InputGroup,
  Portal,
  SegmentGroup,
  Select,
  Spinner,
  Text,
  Textarea,
  VisuallyHidden,
  chakra,
  type ButtonProps,
} from "@chakra-ui/react";
import {
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  CircleStopIcon,
  FolderOpenIcon,
  MicIcon,
  PlusIcon,
  PackagePlusIcon,
  RadioIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useItems } from "@/components/shared/filter-select";
import {
  INVENTORY_ACQUISITION_SOURCE_VALUES,
  INVENTORY_CATEGORY_VALUES,
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_KINDS,
  INVENTORY_ITEM_STATUSES,
  formatInventoryContainerPickerLabel,
  type InventoryAcquisitionSource,
  type InventoryCategory,
  type InventoryImportance,
  type InventoryItemKind,
  type InventoryItemStatus,
} from "@/lib/inventory-client-contract";
import { generateInventoryContainerReferenceId } from "@/lib/inventory-container-reference";
import {
  captureInventoryItemFromBrowser,
  inventoryItemMediaContentPath,
  inventoryItemMediaFilesSignature,
} from "@/lib/quantself-api-browser";
import {
  initialInventoryActionState,
  type InventoryActionState,
  type InventoryContainerImageOption,
  type InventoryContainerActionState,
  type InventoryContainerFormOption,
} from "./action-state";
import {
  ContainerFormDialog,
  type ContainerFormDialogState,
} from "./containers/container-form-dialog";
import { inventorySecondaryButton } from "./inventory-button-styles";
import { InventorySearchField } from "./inventory-search-field";

export type InventoryCaptureAction = (
  state: InventoryActionState,
  formData: FormData,
) => Promise<InventoryActionState>;

export type InventoryCreateContainerAction = (
  state: InventoryContainerActionState,
  formData: FormData,
) => Promise<InventoryContainerActionState>;

export type InventoryCaptureSessionDefaults = {
  container: InventoryContainerFormOption | null;
  containerLabel: string | null;
  destinationLocation: string | null;
  id: string | null;
  label: string | null;
  note: string | null;
  originRoom: string | null;
};

export type InventoryItemCandidate = {
  id: string;
  imageId: string | null;
  placements: Array<{
    label: string;
    quantity: number;
  }>;
  title: string;
  totalQuantity: number;
};

export type InventoryLocationOption = {
  id: string;
  name: string;
};

const imageAccept =
  ".jpg,.jpeg,.png,.webp,.tif,.tiff,.bmp,image/jpeg,image/png,image/webp,image/tiff,image/bmp";
const audioAccept =
  ".wav,.mp3,.m4a,.aac,.ogg,.opus,.flac,.webm,audio/wav,audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/opus,audio/flac,audio/webm";
const captureInputProps = {
  size: "sm",
  bg: "bg.panel",
  borderColor: "border",
  px: "2.5",
  fontSize: { base: "md", md: "sm" },
} as const;

const captureTextareaProps = {
  minH: "16",
  bg: "bg.panel",
  borderColor: "border",
  px: "2.5",
  py: "2",
  fontSize: { base: "md", md: "sm" },
  css: { fieldSizing: "content" },
} as const;

const evidenceActionProps = {
  ...inventorySecondaryButton,
  size: "sm",
  w: "full",
  minW: "0",
  h: "auto",
  minH: "10",
  gap: "1.5",
  fontSize: { base: "xs", sm: "sm" },
  css: { "& svg": { boxSize: "4" } },
  px: "2",
  py: "2",
  textAlign: "center",
  whiteSpace: "normal",
} satisfies ButtonProps;

const capturePanelProps = {
  bg: "bg.subtle",
  borderColor: "border",
  borderWidth: "1px",
  rounded: "xl",
  p: { base: "3", md: "4" },
  gap: "4",
  minW: "0",
  alignContent: "start",
} as const;

const pickerButtonProps = {
  h: "auto",
  minH: "0",
  w: "full",
  px: "1.5",
  py: "1",
  gap: "2",
  justifyContent: "start",
  fontWeight: "normal",
  rounded: "l1",
  focusVisibleRing: "inside",
  size: "sm",
  variant: "ghost",
  colorPalette: "gray",
  color: "fg",
  _hover: { bg: "bg.emphasized/60" },
  type: "button",
} satisfies ButtonProps;

const noContainerFormValue = "__none";
const noLocationFormValue = "__none";
const emptySelectFormValue = "__none";

type InventorySelectValue = string;

type LocalCaptureMedia = {
  file: File;
  id: string;
  label: string;
  url: string;
};

export function InventoryCaptureSessionCard({
  captureAction,
  containers: initialContainers = [],
  createContainerAction = async () => ({
    status: "error",
    message: "Container creation is unavailable.",
    container: null,
  }),
  initialCategory = null,
  locations = [],
  itemCandidates = [],
  session,
  suggestedItemId = null,
  visualPresets = [],
}: {
  captureAction: InventoryCaptureAction;
  containers?: InventoryContainerFormOption[];
  createContainerAction?: InventoryCreateContainerAction;
  initialCategory?: InventoryCategory | null;
  locations?: InventoryLocationOption[];
  itemCandidates?: InventoryItemCandidate[];
  session: InventoryCaptureSessionDefaults | null;
  suggestedItemId?: string | null;
  visualPresets?: InventoryContainerImageOption[];
}) {
  const [actionState, setActionState] = useState(initialInventoryActionState);
  const [capturedPhotos, setCapturedPhotos] = useState<LocalCaptureMedia[]>([]);
  const [createContainerDialog, setCreateContainerDialog] =
    useState<ContainerFormDialogState | null>(null);
  const [renderedCreateContainerDialog, setRenderedCreateContainerDialog] =
    useState<ContainerFormDialogState | null>(null);
  const [containerFilter, setContainerFilter] = useState("");
  const [captureMode, setCaptureMode] = useState<"existing" | "new">("new");
  const [containers, setContainers] =
    useState<InventoryContainerFormOption[]>(initialContainers);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isAudioRecording, setIsAudioRecording] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [recordedAudioNotes, setRecordedAudioNotes] = useState<
    LocalCaptureMedia[]
  >([]);
  const [itemFilter, setItemFilter] = useState("");
  const [selectedItemId, setSelectedItemId] = useState(suggestedItemId ?? "");
  const [selectedContainerId, setSelectedContainerId] = useState(
    session?.container?.id ?? noContainerFormValue,
  );
  const [selectedLocationId, setSelectedLocationId] =
    useState(noLocationFormValue);
  const directCaptureAttemptRef = useRef<{
    idempotencyKey: string;
    signature: string;
  } | null>(null);
  const mediaUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setContainers(initialContainers);
  }, [initialContainers]);

  useEffect(() => {
    const mediaUrls = mediaUrlsRef.current;

    return () => {
      for (const url of mediaUrls) {
        URL.revokeObjectURL(url);
      }

      mediaUrls.clear();
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const hasCapturedMedia =
      captureMode === "new" &&
      (capturedPhotos.length > 0 || recordedAudioNotes.length > 0);
    const formData = hasCapturedMedia
      ? null
      : buildCaptureFormData(form, capturedPhotos, recordedAudioNotes);

    startTransition(async () => {
      const nextState = hasCapturedMedia
        ? await createItemWithDirectMediaUpload(form)
        : await captureAction(actionState, formData!);

      setActionState(nextState);

      if (nextState.status === "success") {
        form.reset();
        clearCaptureFileInputs(form);
        clearLocalMedia(setCapturedPhotos);
        clearLocalMedia(setRecordedAudioNotes);
        setDetailsOpen(false);
      }
    });
  }

  async function createItemWithDirectMediaUpload(
    form: HTMLFormElement,
  ): Promise<InventoryActionState> {
    try {
      const files = [
        ...capturedPhotos.map((entry) => entry.file),
        ...recordedAudioNotes.map((entry) => entry.file),
      ];
      const request = captureRequestFromForm(form);
      const signature = directCaptureSignature(request, files);
      let attempt = directCaptureAttemptRef.current;

      if (!attempt || attempt.signature !== signature) {
        attempt = {
          idempotencyKey: crypto.randomUUID(),
          signature,
        };
        directCaptureAttemptRef.current = attempt;
      }

      await captureInventoryItemFromBrowser(request, files, {
        idempotencyKey: attempt.idempotencyKey,
      });
      directCaptureAttemptRef.current = null;

      return {
        status: "success",
        message: "Capture saved. Inventory preprocessing queued.",
      };
    } catch (error) {
      return {
        status: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Could not save capture.",
      };
    }
  }

  function addCapturedPhoto(file: File) {
    addLocalMedia(file, "photo", setCapturedPhotos);
  }

  function addRecordedAudio(file: File) {
    addLocalMedia(file, "audio", setRecordedAudioNotes);
  }

  function addLocalMedia(
    file: File,
    kind: "audio" | "photo",
    setMedia: React.Dispatch<React.SetStateAction<LocalCaptureMedia[]>>,
  ) {
    const url = URL.createObjectURL(file);

    mediaUrlsRef.current.add(url);
    setMedia((current) => [
      ...current,
      {
        file,
        id: `${kind}-${Date.now()}-${current.length}`,
        label: file.name,
        url,
      },
    ]);
  }

  function removeLocalMedia(
    id: string,
    setMedia: React.Dispatch<React.SetStateAction<LocalCaptureMedia[]>>,
  ) {
    setMedia((current) => {
      const removed = current.find((entry) => entry.id === id);

      if (removed) {
        URL.revokeObjectURL(removed.url);
        mediaUrlsRef.current.delete(removed.url);
      }

      return current.filter((entry) => entry.id !== id);
    });
  }

  function clearLocalMedia(
    setMedia: React.Dispatch<React.SetStateAction<LocalCaptureMedia[]>>,
  ) {
    setMedia((current) => {
      for (const entry of current) {
        URL.revokeObjectURL(entry.url);
        mediaUrlsRef.current.delete(entry.url);
      }

      return [];
    });
  }

  function openCreateContainerDialog(containerName: string) {
    const dialog: ContainerFormDialogState = {
      mode: "create",
      container: null,
      initialName: containerName || undefined,
    };

    setRenderedCreateContainerDialog(dialog);
    setCreateContainerDialog(dialog);
  }

  const generatedContainerReferenceId =
    generateInventoryContainerReferenceId(containers);
  const selectedItem =
    itemCandidates.find(({ id }) => id === selectedItemId) ?? null;

  return (
    <Grid gap="4">
      <chakra.form display="grid" gap="4" onSubmit={handleSubmit}>
        {session?.id ? (
          <input name="captureSessionId" type="hidden" value={session.id} />
        ) : null}
        <input name="containerId" type="hidden" value={selectedContainerId} />
        <input name="locationId" type="hidden" value={selectedLocationId} />
        <input name="captureMode" type="hidden" value={captureMode} />
        <input name="existingItemId" type="hidden" value={selectedItemId} />

        <SegmentGroup.Root
          aria-label="Capture path"
          size="sm"
          value={captureMode}
          onValueChange={({ value }) => {
            if (value === "new" || value === "existing") {
              setCaptureMode(value);
              if (value === "existing") {
                setSelectedLocationId(noLocationFormValue);
              }
            }
          }}
          minW="0"
          justifySelf={{ base: "stretch", sm: "start" }}
          css={{ "--segment-indicator-bg": "{colors.brand.subtle}" }}
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            items={[
              { value: "new", label: "Create new item" },
              { value: "existing", label: "Add units to existing" },
            ]}
            flex={{ base: "1", sm: "initial" }}
            px={{ base: "2", sm: "4" }}
            textStyle={{ base: "xs", sm: "sm" }}
            _checked={{ color: "brand.fg" }}
          />
        </SegmentGroup.Root>

        <Grid
          alignItems="start"
          gap="4"
          templateColumns={{ md: "minmax(0, 1.2fr) minmax(0, 1fr)" }}
        >
          {captureMode === "new" ? (
            <Grid
              as="section"
              aria-labelledby="capture-evidence-heading"
              {...capturePanelProps}
            >
              <Heading as="h3" id="capture-evidence-heading" size="sm">
                Evidence
              </Heading>
              <PhotoEvidenceField
                capturedPhotos={capturedPhotos}
                onAddPhoto={addCapturedPhoto}
                onRemovePhoto={(id) => removeLocalMedia(id, setCapturedPhotos)}
              />
              <AudioEvidenceField
                onAddAudio={addRecordedAudio}
                onRecordingChange={setIsAudioRecording}
                onRemoveAudio={(id) =>
                  removeLocalMedia(id, setRecordedAudioNotes)
                }
                recordedAudioNotes={recordedAudioNotes}
              />
              <Field.Root gap="3">
                <Field.Label lineHeight="19px" htmlFor="inventory-capture-text">
                  Typed capture text
                </Field.Label>
                <Textarea
                  {...captureTextareaProps}
                  bg="bg.panel"
                  minH="24"
                  defaultValue=""
                  id="inventory-capture-text"
                  name="captureText"
                  placeholder="Passport pouch with charger and pen. Keep in travel drawer."
                />
              </Field.Root>
            </Grid>
          ) : (
            <ExistingItemPicker
              filter={itemFilter}
              onCreateSeparate={() => setCaptureMode("new")}
              onFilterChange={setItemFilter}
              onSelect={setSelectedItemId}
              items={itemCandidates}
              selectedItemId={selectedItemId}
            />
          )}

          <Grid
            as="section"
            aria-labelledby="capture-placement-heading"
            {...capturePanelProps}
          >
            <Heading as="h3" id="capture-placement-heading" size="sm">
              Placement
            </Heading>
            <ContainerPickerField
              containers={containers}
              filter={containerFilter}
              onCreateContainer={openCreateContainerDialog}
              onFilterChange={setContainerFilter}
              onSelectedContainerChange={(containerId) => {
                setSelectedContainerId(containerId);

                if (containerId !== noContainerFormValue) {
                  setSelectedLocationId(noLocationFormValue);
                }
              }}
              selectedContainerId={selectedContainerId}
              sessionContainerLabel={session?.containerLabel ?? null}
            />

            {captureMode === "new" ? (
              <LocationPickerField
                locations={locations}
                onSelectedLocationChange={(locationId) => {
                  setSelectedLocationId(locationId);

                  if (locationId !== noLocationFormValue) {
                    setSelectedContainerId(noContainerFormValue);
                  }
                }}
                selectedLocationId={selectedLocationId}
              />
            ) : null}

            <Field.Root gap="2">
              <Field.Label
                lineHeight="19px"
                htmlFor="inventory-capture-quantity"
              >
                Quantity
              </Field.Label>
              <Input
                {...captureInputProps}
                defaultValue="1"
                id="inventory-capture-quantity"
                min="1"
                name="quantity"
                required
                step="1"
                type="number"
              />
            </Field.Root>

            {captureMode === "new" ? (
              <Collapsible.Root
                lazyMount
                unmountOnExit
                ids={{ content: "inventory-capture-details" }}
                onOpenChange={({ open }) => setDetailsOpen(open)}
                open={detailsOpen}
              >
                <Collapsible.Trigger asChild>
                  <Button
                    {...inventorySecondaryButton}
                    size="sm"
                    justifyContent="space-between"
                    w="full"
                    type="button"
                  >
                    Details
                    {detailsOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
                  </Button>
                </Collapsible.Trigger>

                <Collapsible.Content>
                  <Grid gap="4" pt="4" templateColumns="minmax(0, 1fr)">
                    <Field.Root gap="2">
                      <Field.Label lineHeight="19px" htmlFor="inventory-title">
                        Title
                      </Field.Label>
                      <Input
                        {...captureInputProps}
                        id="inventory-title"
                        name="title"
                      />
                    </Field.Root>

                    <InventorySelectField
                      defaultValue={"GROUP" as InventoryItemKind}
                      getLabel={inventoryKindLabel}
                      id="inventory-kind"
                      label="Kind"
                      name="kind"
                      values={INVENTORY_ITEM_KINDS}
                    />

                    <Field.Root gap="2">
                      <Field.Label
                        lineHeight="19px"
                        htmlFor="inventory-item-note"
                      >
                        Item note
                      </Field.Label>
                      <Textarea
                        {...captureTextareaProps}
                        id="inventory-item-note"
                        name="itemNote"
                      />
                    </Field.Root>

                    <InventorySelectField
                      defaultValue={"UNSURE" as InventoryItemStatus}
                      getLabel={inventoryStatusLabel}
                      id="inventory-status"
                      label="Status"
                      name="status"
                      values={INVENTORY_ITEM_STATUSES}
                    />

                    <InventorySelectField
                      defaultValue={"MEDIUM" as InventoryImportance}
                      getLabel={inventoryImportanceLabel}
                      id="inventory-importance"
                      label="Importance"
                      name="importance"
                      values={INVENTORY_IMPORTANCE_VALUES}
                    />

                    <InventorySelectField
                      defaultValue={initialCategory ?? emptySelectFormValue}
                      emptyLabel="No category"
                      getLabel={inventoryCategoryLabel}
                      id="inventory-category"
                      label="Category"
                      name="category"
                      values={INVENTORY_CATEGORY_VALUES}
                    />

                    <InventorySelectField
                      defaultValue={emptySelectFormValue}
                      emptyLabel="No acquisition source"
                      getLabel={inventoryAcquisitionSourceLabel}
                      id="inventory-acquisition-source"
                      label="Acquisition source"
                      name="acquisitionSource"
                      values={INVENTORY_ACQUISITION_SOURCE_VALUES}
                    />

                    <Field.Root gap="2">
                      <Field.Label
                        lineHeight="19px"
                        htmlFor="inventory-estimated-value"
                      >
                        Estimated value
                      </Field.Label>
                      <InputGroup
                        startElement="CAD"
                        startElementProps={{
                          color: "fg.muted",
                          fontSize: "sm",
                        }}
                      >
                        <Input
                          {...captureInputProps}
                          ps="9"
                          defaultValue=""
                          id="inventory-estimated-value"
                          inputMode="decimal"
                          min="0"
                          name="estimatedValue"
                          placeholder="12.50"
                          step="0.01"
                          type="number"
                        />
                      </InputGroup>
                    </Field.Root>
                  </Grid>
                </Collapsible.Content>
              </Collapsible.Root>
            ) : null}
          </Grid>
        </Grid>

        <Flex
          align={{ base: "stretch", sm: "center" }}
          direction={{ base: "column-reverse", sm: "row" }}
          justify="space-between"
          gap="3"
          borderTopWidth="1px"
          borderColor="border"
          pt="4"
        >
          <Button
            aria-busy={isPending}
            size="md"
            order={{ sm: 1 }}
            ms={{ sm: "auto" }}
            w={{ base: "full", sm: "auto" }}
            colorPalette="brand"
            disabled={
              isAudioRecording ||
              (captureMode === "existing" && !selectedItem) ||
              isPending
            }
            type="submit"
          >
            {isPending && <Spinner data-icon="inline-start" />}
            <PackagePlusIcon />
            {captureMode === "existing"
              ? selectedItem
                ? "Add units to this item"
                : "Select an item"
              : "Create item"}
          </Button>

          {actionState.message ? (
            <Text
              aria-live="polite"
              color={actionState.status === "error" ? "fg.error" : "fg.muted"}
              fontSize="sm"
            >
              {actionState.message}
            </Text>
          ) : null}
        </Flex>
      </chakra.form>
      <ContainerFormDialog
        action={createContainerAction}
        dialog={renderedCreateContainerDialog}
        generatedReferenceId={generatedContainerReferenceId}
        key={
          renderedCreateContainerDialog
            ? `capture-${
                renderedCreateContainerDialog.mode === "create"
                  ? (renderedCreateContainerDialog.initialName ?? "new")
                  : "edit"
              }`
            : "capture-create-container-closed"
        }
        onDone={(nextState) => {
          const createdContainer = nextState.container;

          if (createdContainer) {
            setContainers((current) =>
              mergeContainerOptions(current, createdContainer),
            );
            setSelectedContainerId(createdContainer.id);
          }

          setCreateContainerDialog(null);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setCreateContainerDialog(null);
          }
        }}
        onClosed={() => setRenderedCreateContainerDialog(null)}
        open={createContainerDialog !== null}
        visualPresets={visualPresets}
      />
    </Grid>
  );
}

function ExistingItemPicker({
  filter,
  onCreateSeparate,
  onFilterChange,
  onSelect,
  items,
  selectedItemId,
}: {
  filter: string;
  onCreateSeparate: () => void;
  onFilterChange: (value: string) => void;
  onSelect: (id: string) => void;
  items: InventoryItemCandidate[];
  selectedItemId: string;
}) {
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleItems = items
    .filter(
      (item) =>
        !normalizedFilter ||
        item.title.toLowerCase().includes(normalizedFilter) ||
        item.placements.some(({ label }) =>
          label.toLowerCase().includes(normalizedFilter),
        ),
    )
    .slice(0, 8);

  return (
    <Grid as="section" gap="3" aria-label="Existing Inventory Items">
      <InventorySearchField
        id="inventory-existing-item-search"
        label="Find existing item"
        onValueChange={onFilterChange}
        placeholder="Search title or container"
        value={filter}
      />

      {visibleItems.length > 0 ? (
        <Grid gap="2">
          {visibleItems.map((item) => {
            const selected = item.id === selectedItemId;

            return (
              <chakra.button
                aria-pressed={selected}
                display="grid"
                gridTemplateColumns="4rem minmax(0, 1fr)"
                gap="3"
                rounded="14px"
                borderWidth="1px"
                borderColor={selected ? "brand.border" : "border"}
                bg={selected ? "brand.subtle" : undefined}
                _hover={{ bg: selected ? "brand.subtle" : "bg.muted" }}
                focusVisibleRing="outside"
                p="2"
                textAlign="left"
                key={item.id}
                onClick={() => onSelect(item.id)}
                type="button"
              >
                {item.imageId ? (
                  <chakra.img
                    alt=""
                    boxSize="16"
                    rounded="10px"
                    objectFit="cover"
                    src={inventoryItemMediaContentPath(item.id, item.imageId)}
                  />
                ) : (
                  <Grid
                    as="span"
                    boxSize="16"
                    placeItems="center"
                    rounded="10px"
                    bg="bg.muted"
                    color="fg.muted"
                  >
                    <PackagePlusIcon />
                  </Grid>
                )}
                <Grid as="span" minW="0" alignContent="center" gap="1">
                  <Flex
                    as="span"
                    minW="0"
                    align="center"
                    justify="space-between"
                    gap="2"
                  >
                    <Text as="span" fontWeight="medium" truncate>
                      {item.title}
                    </Text>
                    {item.totalQuantity > 1 ? (
                      <Text
                        as="span"
                        flexShrink="0"
                        fontFamily="mono"
                        color="fg.muted"
                        fontSize="xs"
                      >
                        × {item.totalQuantity}
                      </Text>
                    ) : null}
                  </Flex>
                  <Text as="span" lineClamp="2" color="fg.muted" fontSize="xs">
                    {item.placements.length > 0
                      ? item.placements.map(({ label }) => label).join(" · ")
                      : "Unplaced"}
                  </Text>
                </Grid>
              </chakra.button>
            );
          })}
        </Grid>
      ) : (
        <Text
          rounded="14px"
          borderWidth="1px"
          borderStyle="dashed"
          p="3"
          color="fg.muted"
          fontSize="sm"
        >
          No matching Inventory Item.
        </Text>
      )}

      {selectedItemId ? (
        <Button
          {...inventorySecondaryButton}
          size="sm"
          justifySelf="start"
          onClick={onCreateSeparate}
          type="button"
        >
          Create separate item
        </Button>
      ) : null}
    </Grid>
  );
}

function clearCaptureFileInputs(form: HTMLFormElement): void {
  for (const input of form.querySelectorAll<HTMLInputElement>(
    'input[type="file"]',
  )) {
    input.value = "";
  }
}

function captureRequestFromForm(
  form: HTMLFormElement,
): Parameters<typeof captureInventoryItemFromBrowser>[0] {
  const formData = new FormData(form);
  const captureText =
    formString(formData, "captureText") ?? formString(formData, "itemNote");

  return {
    acquisitionSource: enumFormValue(
      formData,
      "acquisitionSource",
      INVENTORY_ACQUISITION_SOURCE_VALUES,
    ),
    captureSessionId: formString(formData, "captureSessionId"),
    captureText,
    category: enumFormValue(formData, "category", INVENTORY_CATEGORY_VALUES),
    containerId: selectedContainerIdValue(formData),
    containerLabelOverride: null,
    costCents: formCurrencyCents(formData, "estimatedValue"),
    costCurrency: "CAD",
    importance:
      enumFormValue(formData, "importance", INVENTORY_IMPORTANCE_VALUES) ??
      "MEDIUM",
    kind: enumFormValue(formData, "kind", INVENTORY_ITEM_KINDS) ?? "GROUP",
    locationId: selectedLocationIdValue(formData),
    note: formString(formData, "itemNote"),
    quantity: formNumber(formData, "quantity") ?? 1,
    status:
      enumFormValue(formData, "status", INVENTORY_ITEM_STATUSES) ?? "UNSURE",
    title: formString(formData, "title"),
  };
}

function selectedLocationIdValue(formData: FormData): string | undefined {
  const locationId = formString(formData, "locationId");

  return locationId && locationId !== noLocationFormValue
    ? locationId
    : undefined;
}

function directCaptureSignature(
  request: Parameters<typeof captureInventoryItemFromBrowser>[0],
  files: File[],
): string {
  return JSON.stringify({
    files: inventoryItemMediaFilesSignature(files),
    request,
  });
}

function buildCaptureFormData(
  form: HTMLFormElement,
  capturedPhotos: LocalCaptureMedia[],
  recordedAudioNotes: LocalCaptureMedia[],
): FormData {
  const formData = new FormData(form);

  removeEmptyFiles(formData, "images");
  removeEmptyFiles(formData, "audioNotes");

  for (const photo of capturedPhotos) {
    formData.append("images", photo.file);
  }

  for (const audioNote of recordedAudioNotes) {
    formData.append("audioNotes", audioNote.file);
  }

  return formData;
}

function removeEmptyFiles(
  formData: FormData,
  key: "images" | "audioNotes",
): void {
  const files = formData
    .getAll(key)
    .filter((value): value is File => value instanceof File && value.size > 0);

  formData.delete(key);

  for (const file of files) {
    formData.append(key, file);
  }
}

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formNumber(formData: FormData, key: string): number | null {
  const value = formString(formData, key);

  if (!value) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formCurrencyCents(formData: FormData, key: string): number | null {
  const value = formString(formData, key);

  if (!value) {
    return null;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.round(numeric * 100);
}

function enumFormValue<T extends string>(
  formData: FormData,
  key: string,
  values: readonly T[],
): T | null {
  const value = formString(formData, key);

  if (!value || value === emptySelectFormValue) {
    return null;
  }

  return values.includes(value as T) ? (value as T) : null;
}

function selectedContainerIdValue(formData: FormData): string | null {
  const value = formString(formData, "containerId");

  if (!value || value === noContainerFormValue) {
    return null;
  }

  return value;
}

function ContainerPickerField({
  containers,
  filter,
  onCreateContainer,
  onFilterChange,
  onSelectedContainerChange,
  selectedContainerId,
  sessionContainerLabel,
}: {
  containers: InventoryContainerFormOption[];
  filter: string;
  onCreateContainer: (containerName: string) => void;
  onFilterChange: (filter: string) => void;
  onSelectedContainerChange: (containerId: string) => void;
  selectedContainerId: string;
  sessionContainerLabel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const searchInputId = useId();
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const visibleContainers = filterContainers(containers, filter);
  const selectedContainer = containers.find(
    (container) => container.id === selectedContainerId,
  );
  const trimmedFilter = filter.trim();
  const selectedLabel = selectedContainer
    ? formatInventoryContainerPickerLabel(selectedContainer)
    : sessionContainerLabel
      ? `No container (${sessionContainerLabel})`
      : "No container";
  const inputValue = open ? filter : selectedLabel;

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePress(event: MouseEvent) {
      const target = event.target;

      if (target instanceof Node && !pickerRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsidePress);

    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePress);
    };
  }, [open]);

  function openPicker() {
    if (open) {
      return;
    }

    onFilterChange("");
    setOpen(true);
  }

  function chooseContainer(containerId: string) {
    onSelectedContainerChange(containerId);
    onFilterChange("");
    setOpen(false);
  }

  function createContainerFromFilter() {
    const containerName = trimmedFilter;

    onFilterChange("");
    setOpen(false);
    requestAnimationFrame(() => {
      onCreateContainer(containerName);
    });
  }

  function handleFilterInput(event: React.FormEvent<HTMLInputElement>) {
    if (!open) {
      setOpen(true);
    }

    onFilterChange(event.currentTarget.value);
  }

  function focusFirstOption() {
    requestAnimationFrame(() => {
      pickerRef.current
        ?.querySelector<HTMLButtonElement>('[role="option"]')
        ?.focus();
    });
  }

  return (
    <Field.Root gap="2">
      <Field.Label lineHeight="19px" htmlFor={searchInputId}>
        Container
      </Field.Label>
      <Box asChild position="relative" w="full">
        <div ref={pickerRef}>
          <InputGroup
            endElement={<ChevronsUpDownIcon aria-hidden="true" size={16} />}
            endElementProps={{ pointerEvents: "none" }}
          >
            <Input
              {...captureInputProps}
              pe="8"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={open}
              aria-haspopup="listbox"
              truncate
              id={searchInputId}
              onChange={handleFilterInput}
              onClick={openPicker}
              onFocus={openPicker}
              onInput={handleFilterInput}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false);
                  onFilterChange("");
                  event.currentTarget.blur();
                  return;
                }

                if (event.key === "ArrowDown") {
                  openPicker();
                  focusFirstOption();
                  event.preventDefault();
                  return;
                }

                if (event.key === "Enter") {
                  event.preventDefault();
                  openPicker();
                  focusFirstOption();
                }
              }}
              placeholder="Search containers"
              role="combobox"
              type="search"
              value={inputValue}
            />
          </InputGroup>
          {open ? (
            <Box
              position="absolute"
              insetInline="0"
              top="full"
              zIndex="popover"
              mt="2"
              overflow="hidden"
              rounded="l2"
              bg="bg.panel"
              shadow="md"
              role="presentation"
            >
              <Box
                aria-label="Containers"
                maxH="72"
                overflowY="auto"
                p="1"
                id={listboxId}
                role="listbox"
              >
                <ContainerPickerOption
                  label="No container"
                  onSelect={() => chooseContainer(noContainerFormValue)}
                  selected={selectedContainerId === noContainerFormValue}
                />
                {visibleContainers.map((container) => (
                  <ContainerPickerOption
                    key={container.id}
                    label={formatInventoryContainerPickerLabel(container)}
                    onSelect={() => chooseContainer(container.id)}
                    selected={container.id === selectedContainerId}
                  />
                ))}
                {visibleContainers.length === 0 ? (
                  <Text
                    px="3"
                    py="4"
                    textAlign="center"
                    color="fg.muted"
                    fontSize="sm"
                  >
                    {trimmedFilter
                      ? "No matching containers."
                      : "No saved containers."}
                  </Text>
                ) : null}
              </Box>

              <Box borderTopWidth="1px" borderColor="border" p="1">
                <Button
                  {...pickerButtonProps}
                  onClick={createContainerFromFilter}
                >
                  <PlusIcon />
                  <Text as="span" truncate>
                    {trimmedFilter
                      ? `Create "${trimmedFilter}"`
                      : "Create container"}
                  </Text>
                </Button>
              </Box>
            </Box>
          ) : null}
        </div>
      </Box>
    </Field.Root>
  );
}

function LocationPickerField({
  locations,
  onSelectedLocationChange,
  selectedLocationId,
}: {
  locations: InventoryLocationOption[];
  onSelectedLocationChange: (locationId: string) => void;
  selectedLocationId: string;
}) {
  const items = [
    { label: "No direct location", value: noLocationFormValue },
    ...locations.map((location) => ({
      label: location.name,
      value: location.id,
    })),
  ];

  return (
    <CaptureSelect
      id="inventory-capture-location"
      items={items}
      label="Direct location"
      onValueChange={onSelectedLocationChange}
      value={selectedLocationId}
      helperText="Choosing a direct location clears the Container target."
    />
  );
}

function ContainerPickerOption({
  label,
  onSelect,
  selected,
}: {
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <Button
      {...pickerButtonProps}
      aria-selected={selected}
      onClick={onSelect}
      role="option"
    >
      <Text as="span" flex="1" minW="0" textAlign="start" truncate>
        {label}
      </Text>
      {selected && <CheckIcon aria-hidden="true" />}
    </Button>
  );
}

function mergeContainerOptions(
  current: InventoryContainerFormOption[],
  container: InventoryContainerFormOption,
): InventoryContainerFormOption[] {
  const next = current.filter((entry) => entry.id !== container.id);

  return [...next, container].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function filterContainers(
  containers: InventoryContainerFormOption[],
  filter: string,
): InventoryContainerFormOption[] {
  const normalizedFilter = filter.trim().toLowerCase();

  if (!normalizedFilter) {
    return containers;
  }

  return containers.filter((container) =>
    [
      container.name,
      container.referenceId,
      container.locationName,
      container.sizeLiters === null ? null : `${container.sizeLiters}l`,
      container.sizeLiters === null ? null : `${container.sizeLiters} L`,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedFilter),
  );
}

function PhotoEvidenceField({
  capturedPhotos,
  onAddPhoto,
  onRemovePhoto,
}: {
  capturedPhotos: LocalCaptureMedia[];
  onAddPhoto: (file: File) => void;
  onRemovePhoto: (id: string) => void;
}) {
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const labelId = useId();
  const photoActionRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!cameraStream || !videoRef.current) {
      return;
    }

    videoRef.current.srcObject = cameraStream;
    void videoRef.current.play().catch(() => {
      setCameraError("Camera preview could not start.");
    });
  }, [cameraStream]);

  useEffect(() => {
    return () => {
      stopCameraStream(cameraStreamRef.current);
    };
  }, []);

  async function startCamera() {
    if (!hasMediaCaptureSupport()) {
      setCameraError("Camera is unavailable in this browser.");
      return;
    }

    setCameraError(null);
    setCameraOpen(true);
    setCameraStarting(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });

      cameraStreamRef.current = stream;
      setCameraStream(stream);
    } catch {
      setCameraError("Camera permission denied or unavailable.");
      setCameraOpen(false);
    } finally {
      setCameraStarting(false);
    }
  }

  function stopCamera() {
    stopCameraStream(cameraStreamRef.current);
    cameraStreamRef.current = null;
    setCameraStream(null);
    setCameraOpen(false);
  }

  function capturePhoto() {
    const video = videoRef.current;

    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError("Camera preview is not ready.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");

    if (!context) {
      setCameraError("Photo capture is unavailable.");
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setCameraError("Photo capture failed.");
          return;
        }

        onAddPhoto(
          new File([blob], `inventory-photo-${Date.now()}.jpg`, {
            type: "image/jpeg",
          }),
        );
        stopCamera();
      },
      "image/jpeg",
      0.92,
    );
  }

  function focusPhotoActions(event: React.MouseEvent<HTMLLabelElement>) {
    event.preventDefault();
    photoActionRef.current?.focus({ preventScroll: true });
  }

  function uploadPhotos(event: React.MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;

    imageInputRef.current?.click();
    button.focus({ preventScroll: true });
  }

  return (
    <Field.Root gap="3">
      <VisuallyHidden asChild>
        <input
          accept={imageAccept}
          aria-labelledby={labelId}
          id="inventory-images"
          multiple
          name="images"
          onChange={(event) => {
            for (const file of Array.from(event.currentTarget.files ?? [])) {
              onAddPhoto(file);
            }
            event.currentTarget.value = "";
          }}
          ref={imageInputRef}
          tabIndex={-1}
          type="file"
        />
      </VisuallyHidden>
      <chakra.label
        id={labelId}
        onClick={focusPhotoActions}
        fontSize="sm"
        fontWeight="medium"
        lineHeight="19px"
      >
        Photos
      </chakra.label>

      <Grid
        aria-labelledby={labelId}
        role="group"
        templateColumns="repeat(2, minmax(0, 1fr))"
        w="full"
        gap="2"
      >
        <Button
          {...evidenceActionProps}
          id="inventory-photo-action"
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            void startCamera();
          }}
          asChild
          type="button"
        >
          <button ref={photoActionRef}>
            <CameraIcon />
            Take photo
          </button>
        </Button>
        <Button {...evidenceActionProps} onClick={uploadPhotos} type="button">
          <FolderOpenIcon />
          Upload photos
        </Button>
      </Grid>

      {cameraOpen ? (
        <Grid
          gap="3"
          rounded="14px"
          borderWidth="1px"
          bg="bg.subtle"
          p="3"
          w="full"
        >
          {cameraStream ? (
            <chakra.video
              asChild
              aspectRatio="video"
              w="full"
              rounded="10px"
              bg="black"
              objectFit="cover"
            >
              <video muted playsInline ref={videoRef} />
            </chakra.video>
          ) : (
            <Flex
              aspectRatio="video"
              align="center"
              justify="center"
              rounded="10px"
              bg="bg.muted"
              color="fg.muted"
              fontSize="sm"
            >
              {cameraStarting ? "Starting camera..." : "Camera not ready"}
            </Flex>
          )}
          <Flex wrap="wrap" gap="2">
            <Button
              {...inventorySecondaryButton}
              size="sm"
              disabled={!cameraStream}
              onClick={capturePhoto}
              type="button"
            >
              <CameraIcon />
              Capture
            </Button>
            <Button
              {...inventorySecondaryButton}
              size="sm"
              onClick={stopCamera}
              type="button"
            >
              Cancel
            </Button>
          </Flex>
        </Grid>
      ) : null}

      {capturedPhotos.length > 0 ? (
        <MediaList
          entries={capturedPhotos}
          kind="photo"
          onRemove={onRemovePhoto}
        />
      ) : null}

      {cameraError ? (
        <Text color="fg.error" fontSize="sm">
          {cameraError}
        </Text>
      ) : null}
    </Field.Root>
  );
}

function AudioEvidenceField({
  onAddAudio,
  onRecordingChange,
  onRemoveAudio,
  recordedAudioNotes,
}: {
  onAddAudio: (file: File) => void;
  onRecordingChange: (recording: boolean) => void;
  onRemoveAudio: (id: string) => void;
  recordedAudioNotes: LocalCaptureMedia[];
}) {
  const [audioError, setAudioError] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<
    "idle" | "recording" | "requesting"
  >("idle");
  const labelId = useId();
  const audioActionRef = useRef<HTMLButtonElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    onRecordingChange(recordingState !== "idle");
  }, [onRecordingChange, recordingState]);

  useEffect(() => {
    return () => {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }

      stopCameraStream(streamRef.current);
    };
  }, []);

  async function startRecording() {
    if (!hasMediaCaptureSupport() || typeof MediaRecorder === "undefined") {
      setAudioError("Audio recording is unavailable in this browser.");
      return;
    }

    setAudioError(null);
    setRecordingState("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });

        if (blob.size > 0) {
          onAddAudio(
            new File(
              [blob],
              `inventory-audio-${Date.now()}.${audioExtension(mimeType)}`,
              {
                type: mimeType,
              },
            ),
          );
        } else {
          setAudioError("No audio was recorded.");
        }

        chunksRef.current = [];
        recorderRef.current = null;
        stopCameraStream(streamRef.current);
        streamRef.current = null;
        setRecordingState("idle");
      });

      recorder.start();
      setRecordingState("recording");
    } catch {
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      setRecordingState("idle");
      setAudioError("Microphone permission denied or unavailable.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      setRecordingState("idle");
      return;
    }

    recorder.stop();
  }

  function focusAudioActions(event: React.MouseEvent<HTMLLabelElement>) {
    event.preventDefault();
    audioActionRef.current?.focus({ preventScroll: true });
  }

  function uploadAudio(event: React.MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;

    audioInputRef.current?.click();
    button.focus({ preventScroll: true });
  }

  return (
    <Field.Root gap="3">
      <VisuallyHidden asChild>
        <input
          accept={audioAccept}
          aria-labelledby={labelId}
          id="inventory-audio-notes"
          multiple
          name="audioNotes"
          onChange={(event) => {
            for (const file of Array.from(event.currentTarget.files ?? [])) {
              onAddAudio(file);
            }
            event.currentTarget.value = "";
          }}
          ref={audioInputRef}
          tabIndex={-1}
          type="file"
        />
      </VisuallyHidden>
      <chakra.label
        id={labelId}
        onClick={focusAudioActions}
        fontSize="sm"
        fontWeight="medium"
        lineHeight="19px"
      >
        Audio notes
      </chakra.label>

      <Grid
        aria-labelledby={labelId}
        role="group"
        templateColumns="repeat(2, minmax(0, 1fr))"
        w="full"
        gap="2"
      >
        {recordingState === "idle" ? (
          <Button
            {...evidenceActionProps}
            id="inventory-audio-action"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              void startRecording();
            }}
            asChild
            type="button"
          >
            <button ref={audioActionRef}>
              <MicIcon />
              Record audio
            </button>
          </Button>
        ) : (
          <Button
            {...evidenceActionProps}
            colorPalette="red"
            color="fg.error"
            bg="bg.error"
            borderColor="border.error"
            id="inventory-audio-action"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              stopRecording();
            }}
            asChild
            type="button"
          >
            <button ref={audioActionRef}>
              <CircleStopIcon />
              Stop recording
            </button>
          </Button>
        )}
        <Button {...evidenceActionProps} onClick={uploadAudio} type="button">
          <FolderOpenIcon />
          Upload audio
        </Button>
      </Grid>

      {recordingState !== "idle" ? (
        <Flex
          align="center"
          gap="2"
          rounded="14px"
          borderWidth="1px"
          borderColor="border.error"
          bg="bg.error"
          px="3"
          py="2"
          color="fg.error"
          fontSize="sm"
          w="full"
        >
          <RadioIcon size={16} />
          {recordingState === "requesting"
            ? "Opening microphone..."
            : "Recording"}
        </Flex>
      ) : null}

      {recordedAudioNotes.length > 0 ? (
        <MediaList
          entries={recordedAudioNotes}
          kind="audio"
          onRemove={onRemoveAudio}
        />
      ) : null}

      {audioError ? (
        <Text color="fg.error" fontSize="sm">
          {audioError}
        </Text>
      ) : null}
    </Field.Root>
  );
}

function MediaList({
  entries,
  kind,
  onRemove,
}: {
  entries: LocalCaptureMedia[];
  kind: "audio" | "photo";
  onRemove: (id: string) => void;
}) {
  return (
    <Grid as="ul" listStyle="none" gap="2" w="full">
      {entries.map((entry) => (
        <Grid
          as="li"
          key={entry.id}
          gap="2"
          rounded="14px"
          borderWidth="1px"
          bg="bg.subtle"
          p="2"
        >
          {kind === "photo" ? (
            <chakra.img
              alt=""
              aspectRatio="video"
              w="full"
              rounded="10px"
              objectFit="cover"
              src={entry.url}
            />
          ) : (
            <chakra.audio w="full" controls src={entry.url} />
          )}
          <Flex align="center" justify="space-between" gap="2">
            <Text as="span" truncate color="fg.muted" fontSize="xs">
              {entry.label}
            </Text>
            <IconButton
              aria-label={`Remove ${kind}`}
              onClick={() => onRemove(entry.id)}
              size="xs"
              type="button"
              variant="ghost"
            >
              <Trash2Icon />
            </IconButton>
          </Flex>
        </Grid>
      ))}
    </Grid>
  );
}

function hasMediaCaptureSupport(): boolean {
  return Boolean(
    typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia,
  );
}

function stopCameraStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function audioExtension(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("aac")) {
    return "m4a";
  }

  if (mimeType.includes("ogg") || mimeType.includes("opus")) {
    return "ogg";
  }

  return "webm";
}

function InventorySelectField<Value extends InventorySelectValue>({
  defaultValue,
  emptyLabel,
  getLabel,
  id,
  label,
  name,
  values,
}: {
  defaultValue: Value | typeof emptySelectFormValue;
  emptyLabel?: string;
  getLabel: (value: Value) => string;
  id: string;
  label: string;
  name: string;
  values: readonly Value[];
}) {
  const items = [
    ...(emptyLabel
      ? [{ label: emptyLabel, value: emptySelectFormValue as Value }]
      : []),
    ...values.map((value) => ({
      label: getLabel(value),
      value,
    })),
  ];

  return (
    <CaptureSelect
      defaultValue={defaultValue}
      id={id}
      items={items}
      label={label}
      name={name}
    />
  );
}

function CaptureSelect({
  defaultValue,
  helperText,
  id,
  items,
  label,
  name,
  onValueChange,
  value,
}: {
  defaultValue?: string;
  helperText?: string;
  id: string;
  items: Array<{ label: string; value: string }>;
  label: string;
  name?: string;
  onValueChange?: (value: string) => void;
  value?: string;
}) {
  const collection = useItems(items);
  const helperId = helperText ? `${id}-help` : undefined;

  return (
    <Select.Root
      collection={collection}
      defaultValue={defaultValue === undefined ? undefined : [defaultValue]}
      ids={{ trigger: id }}
      lazyMount
      name={name}
      onValueChange={({ value: [nextValue] }) => {
        if (nextValue !== undefined) {
          onValueChange?.(nextValue);
        }
      }}
      size="sm"
      gap="2"
      unmountOnExit
      value={value === undefined ? undefined : [value]}
    >
      <Select.Label lineHeight="19px">{label}</Select.Label>
      {name && <Select.HiddenSelect />}
      <Select.Control>
        <Select.Trigger
          aria-describedby={helperId}
          bg="bg.panel"
          borderColor="border"
        >
          <Select.ValueText />
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator />
        </Select.IndicatorGroup>
      </Select.Control>
      {helperText && (
        <Text id={helperId} color="fg.muted" fontSize="xs">
          {helperText}
        </Text>
      )}
      <Portal>
        <Select.Positioner>
          <Select.Content>
            {items.map((item) => (
              <Select.Item item={item} key={item.value}>
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}

function inventoryKindLabel(kind: InventoryItemKind): string {
  return kind === "GROUP" ? "Item group" : "Single item";
}

function inventoryStatusLabel(status: InventoryItemStatus): string {
  const labels: Record<InventoryItemStatus, string> = {
    DONATE: "Donate",
    KEEP: "Keep",
    TRASH: "Trash",
    UNSURE: "Unsure",
  };

  return labels[status];
}

function inventoryImportanceLabel(importance: InventoryImportance): string {
  const labels: Record<InventoryImportance, string> = {
    HIGH: "High",
    LOW: "Low",
    MEDIUM: "Medium",
  };

  return labels[importance];
}

function inventoryCategoryLabel(category: InventoryCategory): string {
  const labels: Record<InventoryCategory, string> = {
    cleaning: "Cleaning",
    clothing: "Clothing",
    cosmetics: "Cosmetics",
    documents: "Documents",
    drink: "Drink",
    entertainment: "Entertainment",
    food: "Food",
    homeopathy: "Homeopathy",
    household: "Household",
    kitchen: "Kitchen",
    medical: "Medical",
    office: "Office",
    other: "Other",
    sports: "Sports",
    supplement: "Supplement",
    technology: "Technology",
    tools: "Tools",
  };

  return labels[category];
}

function inventoryAcquisitionSourceLabel(
  acquisitionSource: InventoryAcquisitionSource,
): string {
  const labels: Record<InventoryAcquisitionSource, string> = {
    found: "Found",
    gift: "Gift",
    online: "Online",
    other: "Other",
    retail: "Retail",
    secondhand: "Secondhand",
    work: "Work",
  };

  return labels[acquisitionSource];
}
