import {
  isInventoryEnrichmentRepository,
  queueInventoryEnrichmentCapture,
} from "./inventory-enrichment-service";
import {
  isInventoryPreprocessingRepository,
  queueInventoryPreprocessingCapture,
} from "./inventory-preprocessing-service";
import {
  generateInventoryContainerReferenceId,
  normalizeInventoryContainerReferenceId,
} from "../../web/lib/inventory-container-reference";
import {
  getInventoryContainerVisualCatalogEntry,
  type InventoryContainerVisualBounds,
  type InventoryContainerVisualKey,
} from "../../web/lib/inventory-container-visual-catalog";
import {
  buildInventorySearchCorpus,
  inventorySearchTerms,
  matchesInventorySearchQuery,
  normalizeInventorySearchText,
} from "../../web/lib/inventory-search";
import {
  cleanOptional,
  normalizeInventoryAcquisitionSource,
  normalizeInventoryCategory,
  type InventoryAcquisitionSource,
  type InventoryCategory,
  type InventoryImportance,
  type InventoryItemKind,
  type InventoryItemStatus,
} from "./inventory-values";

export { normalizeInventoryContainerReferenceId } from "../../web/lib/inventory-container-reference";
export {
  INVENTORY_ACQUISITION_SOURCE_VALUES,
  INVENTORY_CATEGORY_VALUES,
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_KINDS,
  INVENTORY_ITEM_STATUSES,
  cleanOptional,
  formatInventoryAcquisitionSourceLabel,
  formatInventoryCategoryLabel,
  formatInventoryContainerPickerLabel,
  normalizeInventoryAcquisitionSource,
  normalizeInventoryCategory,
  type InventoryAcquisitionSource,
  type InventoryCategory,
  type InventoryImportance,
  type InventoryItemKind,
  type InventoryItemStatus,
} from "./inventory-values";
export type InventoryLocationKind =
  | "ROOM"
  | "STORAGE"
  | "SHELF"
  | "AREA"
  | "OTHER";

export interface InventoryLocationRecord {
  id: string;
  name: string;
  kind: InventoryLocationKind;
}

export interface InventoryContainerVisualPresetRecord {
  backImageUrl: string;
  name: string;
  emptyImageUrl: string;
  frontImageUrl: string;
  height: number;
  id: InventoryContainerVisualKey;
  bounds: InventoryContainerVisualBounds;
  isDefault: boolean;
  shadowImageUrl: string;
  width: number;
}

export interface InventoryContainerRecord {
  id: string;
  referenceId: string;
  name: string;
  normalizedName: string;
  locationId: string | null;
  location: InventoryLocationRecord | null;
  visualPresetKey: string;
  visualPreset: InventoryContainerVisualPresetRecord;
  sizeLiters: number | null;
  /** @deprecated Container rendering uses visualPreset. */
  photoFilePath?: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryContainerSummary {
  id: string;
  referenceId: string;
  name: string;
  locationName: string | null;
  visualPresetKey: string;
  visualPreset: InventoryContainerVisualPresetRecord;
  sizeLiters: number | null;
  /** @deprecated Container rendering uses visualPreset. */
  photoFilePath?: string | null;
  itemCount: number;
  unitCount?: number;
  sampleImages: Array<{
    id: string;
    alt: string;
    caption: string | null;
  }>;
  sampleItems: InventoryContainerItemPreview[];
  latestCapturedAt: Date | null;
}

export interface InventoryContainerItemPreview {
  audioId: string | null;
  hasAudio: boolean;
  id: string;
  localQuantity?: number;
  imageHeight?: number | null;
  imageId: string | null;
  imageIds?: string[];
  imageWidth?: number | null;
  textPreview: string | null;
  title: string;
  totalQuantity?: number;
  videoId?: string | null;
}

export interface InventorySessionRecord {
  id: string;
  label: string | null;
  defaultOriginLocation: InventoryLocationRecord | null;
  defaultDestinationLocation: InventoryLocationRecord | null;
  defaultContainer?: InventoryContainerRecord | null;
  defaultContainerLabel: string | null;
  note: string | null;
  startedAt: Date;
}

export interface InventoryItemImageRecord {
  id?: string;
  filePath: string;
  originalName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  position?: number;
  caption?: string | null;
  ocrText?: string | null;
}

export interface InventoryItemAudioRecord {
  id?: string;
  filePath: string;
  originalName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface InventoryItemAssetRecord {
  id?: string;
  filePath: string;
  originalName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface InventoryItemPlacementRecord {
  id: string;
  itemId: string;
  containerId: string | null;
  container: InventoryContainerRecord | null;
  locationId?: string | null;
  location?: InventoryLocationRecord | null;
  quantity: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryClothingProfileAttributesRecord {
  version: 1;
  kind?: string;
  colors?: string[];
  layer?: string;
  warmth?: string;
  formality?: string;
  weather?: string[];
  occasionTags?: string[];
  material?: string;
  fitNotes?: string;
  decisionNotes?: string;
}

export interface InventoryClothingProfileRecord {
  isDirty: boolean;
  dirtyQuantity?: number;
  attributes: InventoryClothingProfileAttributesRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryRemedyExternalReferenceRecord {
  source: string;
  url: string;
  referenceId?: string;
}

export interface InventoryRemedyProfileRecord {
  substanceId: string;
  potencies: string[];
  selectionSummary: string | null;
  externalReferences: InventoryRemedyExternalReferenceRecord[];
  registeredByClientId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryItemRecord {
  id: string;
  captureSessionId: string | null;
  kind: InventoryItemKind;
  title: string | null;
  note: string | null;
  captureText?: string | null;
  status: InventoryItemStatus;
  importance: InventoryImportance;
  originLocationId: string | null;
  originLocationName: string | null;
  locationId: string | null;
  locationName: string | null;
  containerId?: string | null;
  container?: InventoryContainerRecord | null;
  containerLabel: string | null;
  category: InventoryCategory | null;
  acquisitionSource: InventoryAcquisitionSource | null;
  costCents: number | null;
  costCurrency: string;
  tags: string[];
  aliases: string[];
  searchText: string;
  metadata: Record<string, unknown>;
  clothingProfile?: InventoryClothingProfileRecord | null;
  remedyProfile?: InventoryRemedyProfileRecord | null;
  archivedAt?: Date | null;
  placements?: InventoryItemPlacementRecord[];
  totalQuantity?: number;
  images: InventoryItemImageRecord[];
  audioNotes?: InventoryItemAudioRecord[];
  assets?: InventoryItemAssetRecord[];
  capturedAt: Date;
}

export type InventoryItemFileKind = "image" | "audio" | "asset";

export interface InventoryItemFileRecord {
  id: string;
  kind: InventoryItemFileKind;
  filePath: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export type InventoryItemManualField =
  | "acquisitionSource"
  | "aliases"
  | "captureText"
  | "category"
  | "costCents"
  | "costCurrency"
  | "importance"
  | "kind"
  | "note"
  | "status"
  | "tags"
  | "title";

export interface InventoryItemUpdateRecordInput {
  id: string;
  kind: InventoryItemKind;
  title: string | null;
  note: string | null;
  captureText: string | null;
  status: InventoryItemStatus;
  importance: InventoryImportance;
  /** Derived compatibility fields; Placement mutations own storage. */
  containerId: string | null;
  /** Derived compatibility fields; Placement mutations own storage. */
  containerLabel: string | null;
  category: InventoryCategory | null;
  acquisitionSource: InventoryAcquisitionSource | null;
  costCents: number | null;
  costCurrency: string;
  tags: string[];
  aliases: string[];
  searchText: string;
  metadata: Record<string, unknown>;
  clothingProfile?: InventoryClothingProfileRecord | null;
  remedyProfile?: InventoryRemedyProfileRecord | null;
  addImages: InventoryItemImageRecord[];
  addAudioNotes: InventoryItemAudioRecord[];
  addAssets: InventoryItemAssetRecord[];
  removeImageIds: string[];
  removeAudioNoteIds: string[];
  removeAssetIds: string[];
}

export interface InventoryRepository {
  upsertLocation(input: {
    name?: string | null;
    kind?: InventoryLocationKind;
  }): Promise<InventoryLocationRecord | null>;
  upsertCaptureSession(input: {
    id?: string | null;
    label?: string | null;
    defaultOriginLocation: InventoryLocationRecord | null;
    defaultDestinationLocation: InventoryLocationRecord | null;
    defaultContainer?: InventoryContainerRecord | null;
    defaultContainerLabel?: string | null;
    note?: string | null;
  }): Promise<InventorySessionRecord>;
  getCaptureSession(id: string): Promise<InventorySessionRecord | null>;
  getActiveCaptureSession(): Promise<InventorySessionRecord | null>;
  createItem(
    input: Omit<InventoryItemRecord, "id" | "capturedAt"> & {
        initialPlacement?: {
          containerId: string | null;
          note: string | null;
          quantity: number;
        };
      },
  ): Promise<InventoryItemRecord>;
  listRecentItems(limit: number): Promise<InventoryItemRecord[]>;
  findInventoryItems(
    filters: InventorySearchFilters,
  ): Promise<InventoryItemRecord[]>;
}

export function defaultInventoryClothingProfileAttributes(): InventoryClothingProfileAttributesRecord {
  return { version: 1 };
}

export interface InventoryContainerRepository extends InventoryRepository {
  upsertContainer(input: {
    id?: string | null;
    name: string;
    normalizedName: string;
    referenceId: string;
    location: InventoryLocationRecord | null;
    visualPresetKey: string;
    sizeLiters?: number | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<InventoryContainerRecord>;
  getContainer(id: string): Promise<InventoryContainerRecord | null>;
  listContainers(): Promise<InventoryContainerRecord[]>;
  listContainerSummaries(): Promise<InventoryContainerSummary[]>;
  listItemsForContainer(id: string): Promise<InventoryItemRecord[]>;
  deleteContainer(id: string): Promise<void>;
}

export interface InventoryContainerVisualPresetRepository
  extends InventoryContainerRepository {
  listContainerVisualPresets(): Promise<
    InventoryContainerVisualPresetRecord[]
  >;
}

export interface InventoryItemMutationRepository extends InventoryRepository {
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
  updateItem(
    input: InventoryItemUpdateRecordInput,
  ): Promise<InventoryItemRecord>;
  deleteItem(id: string): Promise<void>;
}

export interface InventoryPlacementMutationRepository {
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
  addInventoryUnits(input: {
    itemId: string;
    containerId: string | null;
    locationId: string | null;
    quantity: number;
    note: string | null;
  }): Promise<InventoryItemRecord>;
  moveInventoryUnits(input: {
    itemId: string;
    sourceContainerId: string | null;
    sourceLocationId: string | null;
    destinationContainerId: string | null;
    destinationLocationId: string | null;
    quantity: number;
  }): Promise<InventoryItemRecord>;
  removeInventoryUnits(input: {
    itemId: string;
    containerId: string | null;
    locationId: string | null;
    quantity: number;
  }): Promise<InventoryItemRecord>;
  reorderInventoryItemImages(input: {
    itemId: string;
    imageIds: string[];
  }): Promise<InventoryItemRecord>;
}

export interface InventoryArchiveRepository {
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
  listArchivedItems(): Promise<InventoryItemRecord[]>;
  setItemArchivedAt(
    id: string,
    archivedAt: Date | null,
  ): Promise<InventoryItemRecord>;
}

export interface InventoryRelocationRepository {
  getContainer(id: string): Promise<InventoryContainerRecord | null>;
  moveItemsToContainer(input: {
    containerId: string;
    itemIds: string[];
  }): Promise<InventoryItemRecord[]>;
}

export interface InventoryContainerReferenceRepository {
  getContainerByReferenceId(
    referenceId: string,
  ): Promise<InventoryContainerRecord | null>;
}

export interface InventoryContainerReferenceAllocator {
  allocateContainerReferenceId(): Promise<string>;
}

export interface CreateCaptureSessionInput {
  id?: string | null;
  label?: string | null;
  originRoom?: string | null;
  destinationLocation?: string | null;
  defaultContainerId?: string | null;
  defaultContainerLabel?: string | null;
  note?: string | null;
}

export interface CreateInventoryContainerInput {
  id?: string | null;
  name?: string | null;
  referenceId?: string | null;
  locationName?: string | null;
  visualPresetKey?: string | null;
  sizeLiters?: number | null;
}

export interface DeleteInventoryContainerInput {
  id?: string | null;
}

export interface CreateInventoryItemInput {
  captureSessionId?: string | null;
  kind?: InventoryItemKind | null;
  title?: string | null;
  note?: string | null;
  captureText?: string | null;
  status?: InventoryItemStatus | null;
  importance?: InventoryImportance | null;
  category?: InventoryCategory | null;
  acquisitionSource?: InventoryAcquisitionSource | null;
  costCents?: number | null;
  costCurrency?: string | null;
  containerId?: string | null;
  containerLabelOverride?: string | null;
  quantity?: number | null;
  clothingProfile?: InventoryClothingProfileRecord | null;
  remedyProfile?: InventoryRemedyProfileRecord | null;
  images?: InventoryItemImageRecord[];
  audioNotes?: InventoryItemAudioRecord[];
  assets?: InventoryItemAssetRecord[];
}

export interface UpdateInventoryItemInput {
  id?: string | null;
  kind?: InventoryItemKind | null;
  title?: string | null;
  note?: string | null;
  captureText?: string | null;
  status?: InventoryItemStatus | null;
  importance?: InventoryImportance | null;
  category?: InventoryCategory | null;
  acquisitionSource?: InventoryAcquisitionSource | null;
  costCents?: number | null;
  costCurrency?: string | null;
  containerId?: string | null;
  containerLabelOverride?: string | null;
  tags?: string[] | null;
  aliases?: string[] | null;
  addImages?: InventoryItemImageRecord[];
  addAudioNotes?: InventoryItemAudioRecord[];
  addAssets?: InventoryItemAssetRecord[];
  removeImageIds?: string[];
  removeAudioNoteIds?: string[];
  removeAssetIds?: string[];
}

export interface DeleteInventoryItemInput {
  id?: string | null;
}

export interface ArchiveInventoryItemInput {
  id?: string | null;
}

export interface MoveInventoryItemsInput {
  containerId?: string | null;
  itemIds?: string[] | null;
}

export interface AddInventoryUnitsInput {
  itemId?: string | null;
  containerId?: string | null;
  locationId?: string | null;
  quantity?: number | null;
  note?: string | null;
}

export interface MoveInventoryUnitsInput {
  itemId?: string | null;
  sourceContainerId?: string | null;
  sourceLocationId?: string | null;
  destinationContainerId?: string | null;
  destinationLocationId?: string | null;
  quantity?: number | null;
}

export interface RemoveInventoryUnitsInput {
  itemId?: string | null;
  containerId?: string | null;
  locationId?: string | null;
  quantity?: number | null;
}

export interface InventoryItemMutationResult {
  item: InventoryItemRecord;
  removedFiles: InventoryItemFileRecord[];
}

export interface InventoryItemDeletionResult {
  item: InventoryItemRecord;
  deletedFiles: InventoryItemFileRecord[];
}

export interface InventorySearchFilters {
  query?: string | null;
  status?: InventoryItemStatus | null;
  importance?: InventoryImportance | null;
  container?: string | null;
  location?: string | null;
  category?: InventoryCategory | null;
  acquisitionSource?: InventoryAcquisitionSource | null;
}

export type InventorySearchResult = InventoryItemRecord & {
  whereLabel: string;
  matchExplanation: string;
  matchFields: string[];
};

type MetadataRule = {
  category: InventoryCategory;
  tags: string[];
  aliases: string[];
  terms: RegExp;
};

type InventoryMetadataInput = {
  title: string | null;
  note: string | null;
  captureText: string | null;
  status: InventoryItemStatus;
  importance: InventoryImportance;
  kind: InventoryItemKind;
  selectedCategory: InventoryCategory | null;
  acquisitionSource: InventoryAcquisitionSource | null;
  costCents: number | null;
  originLocationName: string | null;
  locationName: string | null;
  containerReferenceId: string | null;
  containerLocationName: string | null;
  containerLabel: string | null;
  images: InventoryItemImageRecord[];
  audioNotes: InventoryItemAudioRecord[];
  assets?: InventoryItemAssetRecord[];
};

type InventoryScoreField = {
  name: string;
  value: string | null | undefined;
};

const DEFAULT_ITEM_KIND: InventoryItemKind = "GROUP";
const DEFAULT_ITEM_STATUS: InventoryItemStatus = "UNSURE";
const DEFAULT_IMPORTANCE: InventoryImportance = "MEDIUM";
const INVENTORY_METADATA_GENERATOR = "local-deterministic-v1";
const INVENTORY_METADATA_SCHEMA_VERSION = 1;
export const INVENTORY_ITEM_MANUAL_FIELD_LOCKS_METADATA_KEY =
  "manualFieldLocks";

const INVENTORY_METADATA_SOURCE_FIELDS = [
  "title",
  "note",
  "captureText",
  "containerLabel",
  "container.referenceId",
  "container.locationName",
  "images.originalName",
  "images.caption",
  "images.ocrText",
  "audioNotes.originalName",
  "assets.originalName",
] as const;

const INVENTORY_METADATA_FUTURE_HOOKS = {
  embeddings: "searchText",
  enrichment: "metadata.enrichment",
  ocr: "images.ocrText",
  reindexing: "stored inventory fields",
  speechToText: "captureText",
  visionCaption: "images.caption",
} as const;

type InventoryMetadataSourceField =
  (typeof INVENTORY_METADATA_SOURCE_FIELDS)[number];

type InventoryMetadataFutureHook =
  keyof typeof INVENTORY_METADATA_FUTURE_HOOKS;

type InventoryGeneratedMetadata = Record<string, unknown> & {
  futureHooks: Record<InventoryMetadataFutureHook, string>;
  generator: typeof INVENTORY_METADATA_GENERATOR;
  schemaVersion: typeof INVENTORY_METADATA_SCHEMA_VERSION;
  sourceFields: InventoryMetadataSourceField[];
};

const metadataRules: MetadataRule[] = [
  {
    category: "technology",
    tags: ["electronics", "adapter", "cable"],
    aliases: ["connect laptop to tv", "display cable", "video adapter"],
    terms: /\b(hdmi|usb|adapter|dongle|charger|cable|cord|laptop|monitor|tv)\b/i,
  },
  {
    category: "documents",
    tags: ["documents", "paper"],
    aliases: ["important papers", "records"],
    terms: /\b(document|paper|receipt|manual|passport|record|file|folder)\b/i,
  },
  {
    category: "tools",
    tags: ["tools", "hardware"],
    aliases: ["repair supplies", "fix kit"],
    terms: /\b(tool|screwdriver|drill|hammer|wrench|hardware|nail|screw)\b/i,
  },
  {
    category: "cleaning",
    tags: ["cleaning", "supplies"],
    aliases: ["cleaning supplies"],
    terms: /\b(clean|cleaning|spray|soap|detergent|wipe|sponge|brush)\b/i,
  },
  {
    category: "kitchen",
    tags: ["kitchen", "household"],
    aliases: ["kitchen supplies"],
    terms: /\b(kitchen|pan|pot|lid|plate|bowl|mug|utensil|takeout)\b/i,
  },
  {
    category: "clothing",
    tags: ["clothing", "soft goods"],
    aliases: ["clothes", "wearables"],
    terms: /\b(shirt|pants|sock|jacket|coat|clothing|clothes|shoe|fabric)\b/i,
  },
];

export async function createCaptureSession(
  repository: InventoryRepository,
  input: CreateCaptureSessionInput,
): Promise<InventorySessionRecord> {
  return saveCaptureSession(repository, input);
}

export async function saveCaptureSession(
  repository: InventoryRepository,
  input: CreateCaptureSessionInput,
): Promise<InventorySessionRecord> {
  const defaultOriginLocation = await repository.upsertLocation({
    name: input.originRoom,
    kind: "ROOM",
  });
  const defaultDestinationLocation = await repository.upsertLocation({
    name: input.destinationLocation,
    kind: inferLocationKind(input.destinationLocation),
  });
  const defaultContainer = await resolveContainerById(
    repository,
    input.defaultContainerId,
  );

  return repository.upsertCaptureSession({
    id: cleanOptional(input.id),
    label: cleanOptional(input.label),
    defaultOriginLocation,
    defaultDestinationLocation,
    defaultContainer,
    defaultContainerLabel: cleanOptional(input.defaultContainerLabel),
    note: cleanOptional(input.note),
  });
}

export async function createInventoryContainer(
  repository: InventoryContainerRepository,
  input: CreateInventoryContainerInput,
): Promise<InventoryContainerRecord> {
  const id = cleanOptional(input.id);
  const name = cleanOptional(input.name);

  if (!name) {
    throw new Error("Container name is required.");
  }

  const normalizedName = normalizeInventoryContainerName(name);
  const existingContainers = await repository.listContainers();
  const duplicateName = existingContainers.find(
    (container) =>
      container.normalizedName === normalizedName && container.id !== id,
  );

  if (duplicateName) {
    throw new Error("A container with that name already exists.");
  }

  const requestedReferenceId = cleanOptional(input.referenceId);
  const referenceId = normalizeInventoryContainerReferenceId(
    requestedReferenceId ??
      (hasContainerReferenceAllocator(repository)
        ? await repository.allocateContainerReferenceId()
        : generateInventoryContainerReferenceId(existingContainers)),
  );
  const duplicateReference = existingContainers.find(
    (container) =>
      normalizeInventoryContainerReferenceId(container.referenceId) ===
        referenceId && container.id !== id,
  );

  if (duplicateReference) {
    throw new Error("A container with that reference ID already exists.");
  }

  const location = await repository.upsertLocation({
    name: input.locationName,
    kind: inferLocationKind(input.locationName),
  });
  const visualPresetKey = cleanOptional(input.visualPresetKey);

  if (!visualPresetKey) {
    throw new Error("Container image is required.");
  }
  if (!getInventoryContainerVisualCatalogEntry(visualPresetKey)) {
    throw new Error("Container image must match the repository catalog.");
  }

  return repository.upsertContainer({
    id,
    name,
    normalizedName,
    referenceId,
    location,
    visualPresetKey,
    sizeLiters: normalizeContainerSizeLiters(input.sizeLiters),
    metadata: {},
  });
}

export async function deleteInventoryContainer(
  repository: InventoryContainerRepository,
  input: DeleteInventoryContainerInput,
): Promise<InventoryContainerRecord> {
  const id = cleanOptional(input.id);

  if (!id) {
    throw new Error("Container ID is required.");
  }

  const container = await repository.getContainer(id);

  if (!container) {
    throw new Error("Container was not found.");
  }

  await repository.deleteContainer(id);

  return container;
}

export async function listInventoryContainerVisualPresets(
  repository: InventoryContainerVisualPresetRepository,
): Promise<InventoryContainerVisualPresetRecord[]> {
  return repository.listContainerVisualPresets();
}

export async function createInventoryItem(
  repository: InventoryRepository,
  input: CreateInventoryItemInput,
): Promise<InventoryItemRecord> {
  const kind = input.kind ?? DEFAULT_ITEM_KIND;
  const status = input.status ?? DEFAULT_ITEM_STATUS;
  const importance = input.importance ?? DEFAULT_IMPORTANCE;
  const title = cleanOptional(input.title);
  const note = cleanOptional(input.note);
  const captureText = cleanOptional(input.captureText);
  const selectedCategory = normalizeInventoryCategory(input.category);
  const acquisitionSource = normalizeInventoryAcquisitionSource(
    input.acquisitionSource,
  );
  const costCents = normalizeInventoryCostCents(input.costCents);
  const costCurrency = normalizeInventoryCostCurrency(input.costCurrency);
  const quantity = normalizeInventoryQuantity(input.quantity ?? 1);
  const images = (input.images ?? [])
    .map(normalizeInventoryImage)
    .filter((image): image is InventoryItemImageRecord => image !== null);
  const audioNotes = (input.audioNotes ?? [])
    .map(normalizeInventoryAudio)
    .filter((audioNote): audioNote is InventoryItemAudioRecord => audioNote !== null);
  const assets = (input.assets ?? [])
    .map(normalizeInventoryAsset)
    .filter((asset): asset is InventoryItemAssetRecord => asset !== null);

  if (
    !title &&
    !note &&
    !captureText &&
    images.length === 0 &&
    audioNotes.length === 0 &&
    assets.length === 0
  ) {
    throw new Error(
      "Inventory item requires a title, note, capture text, image, or audio note or other asset.",
    );
  }

  const session = await resolveCaptureSession(repository, input.captureSessionId);
  const containerOverride = cleanOptional(input.containerLabelOverride);
  const hasContainerSelection = input.containerId !== undefined;
  const selectedContainer = await resolveContainerById(
    repository,
    input.containerId,
  );
  const container = hasContainerSelection
    ? selectedContainer
    : session?.defaultContainer ?? null;
  const originLocation = session?.defaultOriginLocation ?? null;
  const destinationLocation = container?.location ?? null;
  const containerLabel = container
    ? container.name
    : containerOverride ?? session?.defaultContainerLabel ?? null;
  const metadata = generateInventoryMetadata({
    title,
    note,
    captureText,
    status,
    importance,
    kind,
    selectedCategory,
    acquisitionSource,
    costCents,
    originLocationName: originLocation?.name ?? null,
    locationName: destinationLocation?.name ?? null,
    containerReferenceId: container?.referenceId ?? null,
    containerLocationName: container?.location?.name ?? null,
    containerLabel,
    images,
    audioNotes,
    assets,
  });

  const item = await repository.createItem({
    captureSessionId: session?.id ?? null,
    kind,
    title,
    note,
    captureText,
    status,
    importance,
    originLocationId: originLocation?.id ?? null,
    originLocationName: originLocation?.name ?? null,
    locationId: destinationLocation?.id ?? null,
    locationName: destinationLocation?.name ?? null,
    containerId: container?.id ?? null,
    container,
    containerLabel,
    initialPlacement: {
      containerId: container?.id ?? null,
      note: container ? null : containerLabel,
      quantity,
    },
    category: metadata.category,
    acquisitionSource,
    costCents,
    costCurrency,
    tags: metadata.tags,
    aliases: metadata.aliases,
    searchText: metadata.searchText,
    metadata: metadata.metadata,
    clothingProfile:
      input.clothingProfile ??
      (metadata.category === "clothing"
        ? {
            attributes: defaultInventoryClothingProfileAttributes(),
            createdAt: new Date(),
            dirtyQuantity: 0,
            isDirty: false,
            updatedAt: new Date(),
          }
        : null),
    archivedAt: null,
    placements: [],
    totalQuantity: quantity,
    images,
    audioNotes,
    assets,
  });

  await queueInventoryItemRefresh(repository, item);

  return item;
}

export async function updateInventoryItem(
  repository: InventoryItemMutationRepository,
  input: UpdateInventoryItemInput,
): Promise<InventoryItemMutationResult> {
  const id = cleanOptional(input.id);

  if (!id) {
    throw new Error("Inventory item ID is required.");
  }

  const existing = await repository.getInventoryItem(id);

  if (!existing) {
    throw new Error("Inventory item was not found.");
  }

  const nextImagePosition =
    existing.images.reduce(
      (maximum, image, index) =>
        Math.max(maximum, image.position ?? index),
      -1,
    ) + 1;
  const addImages = (input.addImages ?? [])
    .map(normalizeInventoryImage)
    .filter((image): image is InventoryItemImageRecord => image !== null)
    .map((image, index) => ({
      ...image,
      position: nextImagePosition + index,
    }));
  const addAudioNotes = (input.addAudioNotes ?? [])
    .map(normalizeInventoryAudio)
    .filter(
      (audioNote): audioNote is InventoryItemAudioRecord => audioNote !== null,
    );
  const addAssets = (input.addAssets ?? [])
    .map(normalizeInventoryAsset)
    .filter((asset): asset is InventoryItemAssetRecord => asset !== null);
  const removeImageIds = normalizeInventoryIds(input.removeImageIds);
  const removeAudioNoteIds = normalizeInventoryIds(
    input.removeAudioNoteIds,
  );
  const removeAssetIds = normalizeInventoryIds(input.removeAssetIds);
  const removedFiles = selectInventoryItemFiles(existing, {
    imageIds: removeImageIds,
    audioIds: removeAudioNoteIds,
    assetIds: removeAssetIds,
  });
  const images = [
    ...existing.images.filter(
      (image) => !image.id || !removeImageIds.includes(image.id),
    ),
    ...addImages,
  ];
  const audioNotes = [
    ...(existing.audioNotes ?? []).filter(
      (audioNote) =>
        !audioNote.id || !removeAudioNoteIds.includes(audioNote.id),
    ),
    ...addAudioNotes,
  ];
  const assets = [
    ...(existing.assets ?? []).filter(
      (asset) => !asset.id || !removeAssetIds.includes(asset.id),
    ),
    ...addAssets,
  ];
  const kind = input.kind ?? existing.kind;
  const title =
    input.title === undefined ? existing.title : cleanOptional(input.title);
  const note =
    input.note === undefined ? existing.note : cleanOptional(input.note);
  const captureText =
    input.captureText === undefined
      ? (existing.captureText ?? null)
      : cleanOptional(input.captureText);
  const status = input.status ?? existing.status;
  const importance = input.importance ?? existing.importance;
  const category =
    input.category === undefined
      ? existing.category
      : normalizeInventoryCategory(input.category);

  if (category !== "clothing" && existing.clothingProfile) {
    throw new Error(
      "Inventory Clothing Profile conflicts with non-clothing category.",
    );
  }
  if (category !== "homeopathy" && existing.remedyProfile) {
    throw new Error(
      "Inventory Remedy Profile conflicts with non-homeopathy category.",
    );
  }
  const acquisitionSource =
    input.acquisitionSource === undefined
      ? existing.acquisitionSource
      : normalizeInventoryAcquisitionSource(input.acquisitionSource);
  const costCents =
    input.costCents === undefined
      ? existing.costCents
      : normalizeInventoryCostCents(input.costCents);
  const costCurrency =
    input.costCurrency === undefined
      ? existing.costCurrency
      : normalizeInventoryCostCurrency(input.costCurrency);
  const tags =
    input.tags === undefined || input.tags === null
      ? existing.tags
      : normalizeInventoryStringList(input.tags);
  const aliases =
    input.aliases === undefined || input.aliases === null
      ? existing.aliases
      : normalizeInventoryStringList(input.aliases);
  const selectedContainer = existing.container ?? null;
  const containerId = existing.containerId ?? null;
  const containerLabel = existing.containerLabel;
  const manualFieldLocks = updateManualFieldLocks(existing, input, {
    acquisitionSource,
    aliases,
    captureText,
    category,
    costCents,
    costCurrency,
    importance,
    kind,
    note,
    status,
    tags,
    title,
  });
  const generatedMetadata = generateInventoryMetadata({
    title,
    note,
    captureText,
    status,
    importance,
    kind,
    selectedCategory: category,
    acquisitionSource,
    costCents,
    originLocationName: existing.originLocationName,
    locationName: existing.locationName,
    containerReferenceId: selectedContainer?.referenceId ?? null,
    containerLocationName: selectedContainer?.location?.name ?? null,
    containerLabel,
    images,
    audioNotes,
    assets,
  });
  const searchText = normalizeSearchText([
    title,
    note,
    captureText,
    status,
    importance,
    kind,
    containerLabel,
    selectedContainer?.referenceId,
    selectedContainer?.location?.name,
    category,
    acquisitionSource,
    formatInventoryCostSearchText(costCents),
    ...tags,
    ...aliases,
    ...inventoryImageTextValues(images),
    ...inventoryAudioTextValues(audioNotes),
    ...inventoryAssetTextValues(assets),
    ...inventoryRemedyProfileSearchTextValues(existing.remedyProfile),
  ]);
  const metadata = {
    ...existing.metadata,
    ...generatedMetadata.metadata,
    [INVENTORY_ITEM_MANUAL_FIELD_LOCKS_METADATA_KEY]: manualFieldLocks,
  };

  const item = await repository.updateItem({
    id,
    kind,
    title,
    note,
    captureText,
    status,
    importance,
    containerId,
    containerLabel,
    category,
    acquisitionSource,
    costCents,
    costCurrency,
    tags,
    aliases,
    searchText,
    metadata,
    clothingProfile: category === "clothing"
      ? existing.clothingProfile ?? {
          attributes: defaultInventoryClothingProfileAttributes(),
          createdAt: new Date(),
          dirtyQuantity: 0,
          isDirty: false,
          updatedAt: new Date(),
        }
      : null,
    remedyProfile: existing.remedyProfile ?? null,
    addImages,
    addAudioNotes,
    addAssets,
    removeImageIds,
    removeAudioNoteIds,
    removeAssetIds,
  });

  await queueInventoryItemRefresh(repository, item);

  return { item, removedFiles };
}

export async function deleteInventoryItem(
  repository: InventoryItemMutationRepository,
  input: DeleteInventoryItemInput,
): Promise<InventoryItemDeletionResult> {
  const id = cleanOptional(input.id);

  if (!id) {
    throw new Error("Inventory item ID is required.");
  }

  const item = await repository.getInventoryItem(id);

  if (!item) {
    throw new Error("Inventory item was not found.");
  }

  const deletedFiles = listInventoryItemFiles(item);

  await repository.deleteItem(id);

  return { item, deletedFiles };
}

export async function archiveInventoryItem(
  repository: InventoryArchiveRepository,
  input: ArchiveInventoryItemInput,
  archivedAt = new Date(),
): Promise<InventoryItemRecord> {
  const item = await requireInventoryItem(repository, input.id);

  if (item.archivedAt) {
    return item;
  }

  return repository.setItemArchivedAt(item.id, archivedAt);
}

export async function restoreInventoryItem(
  repository: InventoryArchiveRepository,
  input: ArchiveInventoryItemInput,
): Promise<InventoryItemRecord> {
  const item = await requireInventoryItem(repository, input.id);

  if (!item.archivedAt) {
    return item;
  }

  return repository.setItemArchivedAt(item.id, null);
}

export async function moveInventoryItems(
  repository: InventoryRelocationRepository,
  input: MoveInventoryItemsInput,
): Promise<InventoryItemRecord[]> {
  const containerId = cleanOptional(input.containerId);
  const itemIds = normalizeInventoryIds(input.itemIds);

  if (!containerId) {
    throw new Error("Destination container is required.");
  }

  if (itemIds.length === 0) {
    throw new Error("Select at least one inventory item.");
  }

  const container = await repository.getContainer(containerId);

  if (!container) {
    throw new Error("Destination container was not found.");
  }

  return repository.moveItemsToContainer({ containerId, itemIds });
}

export async function addInventoryUnits(
  repository: InventoryPlacementMutationRepository,
  input: AddInventoryUnitsInput,
): Promise<InventoryItemRecord> {
  const itemId = requireInventoryId(input.itemId, "Inventory Item");
  const target = normalizePlacementTarget(input, "Placement target");

  return repository.addInventoryUnits({
    itemId,
    containerId: target.containerId,
    locationId: target.locationId,
    quantity: normalizeInventoryQuantity(input.quantity ?? 1),
    note: cleanOptional(input.note),
  });
}

export async function moveInventoryUnits(
  repository: InventoryPlacementMutationRepository,
  input: MoveInventoryUnitsInput,
): Promise<InventoryItemRecord> {
  const itemId = requireInventoryId(input.itemId, "Inventory Item");
  const sourceTarget = normalizePlacementTarget(
    {
      containerId: input.sourceContainerId,
      locationId: input.sourceLocationId,
    },
    "source Placement target",
  );
  const destinationTarget = normalizePlacementTarget(
    {
      containerId: input.destinationContainerId,
      locationId: input.destinationLocationId,
    },
    "destination Placement target",
  );

  if (samePlacementTarget(sourceTarget, destinationTarget)) {
    throw new Error("Choose a different destination Placement.");
  }

  return repository.moveInventoryUnits({
    itemId,
    sourceContainerId: sourceTarget.containerId,
    sourceLocationId: sourceTarget.locationId,
    destinationContainerId: destinationTarget.containerId,
    destinationLocationId: destinationTarget.locationId,
    quantity: normalizeInventoryQuantity(input.quantity ?? 1),
  });
}

export async function removeInventoryUnits(
  repository: InventoryPlacementMutationRepository,
  input: RemoveInventoryUnitsInput,
): Promise<InventoryItemRecord> {
  const target = normalizePlacementTarget(input, "Placement target");

  return repository.removeInventoryUnits({
    itemId: requireInventoryId(input.itemId, "Inventory Item"),
    containerId: target.containerId,
    locationId: target.locationId,
    quantity: normalizeInventoryQuantity(input.quantity ?? 1),
  });
}

function normalizePlacementTarget(
  input: {
    containerId?: string | null;
    locationId?: string | null;
  },
  label: string,
): {
  containerId: string | null;
  locationId: string | null;
} {
  const containerId = cleanOptional(input.containerId);
  const locationId = cleanOptional(input.locationId);

  if (containerId && locationId) {
    throw new Error(`Choose exactly one ${label}.`);
  }

  return { containerId, locationId };
}

function samePlacementTarget(
  left: { containerId: string | null; locationId: string | null },
  right: { containerId: string | null; locationId: string | null },
): boolean {
  return (
    left.containerId === right.containerId &&
    left.locationId === right.locationId
  );
}

export async function reorderInventoryItemImages(
  repository: InventoryPlacementMutationRepository,
  input: { itemId?: string | null; imageIds?: string[] | null },
): Promise<InventoryItemRecord> {
  const imageIds = normalizeInventoryIds(input.imageIds);

  if (imageIds.length === 0) {
    throw new Error("Image order is required.");
  }

  return repository.reorderInventoryItemImages({
    itemId: requireInventoryId(input.itemId, "Inventory Item"),
    imageIds,
  });
}

export function formatInventoryPlacementSummary(
  item: Pick<InventoryItemRecord, "placements" | "totalQuantity">,
): string {
  const total =
    item.totalQuantity ??
    (item.placements ?? []).reduce(
      (sum, placement) => sum + placement.quantity,
      0,
    );
  const placements = (item.placements ?? []).map((placement) => {
    const label = formatInventoryPlacementLabel(placement);

    return `${label} ${placement.quantity}`;
  });

  return [`Total ${total}`, ...placements].join(" · ");
}

export async function listRecentInventoryItems(
  repository: InventoryRepository,
  limit = 8,
): Promise<InventorySearchResult[]> {
  const items = await repository.listRecentItems(limit);

  return items.map((item) => decorateInventoryResult(item, null));
}

export async function searchInventory(
  repository: InventoryRepository,
  filters: InventorySearchFilters,
): Promise<InventorySearchResult[]> {
  const query = cleanOptional(filters.query);
  const searchableQuery = inventorySearchTerms(query).length > 0 ? query : null;
  const candidates = await repository.findInventoryItems({
    acquisitionSource: filters.acquisitionSource ?? null,
    category: filters.category ?? null,
    query: searchableQuery,
    status: filters.status ?? null,
    importance: filters.importance ?? null,
    container: cleanOptional(filters.container),
    location: cleanOptional(filters.location),
  });
  const ranked = candidates
    .map((item) => ({
      item,
      score: scoreInventoryItem(item, searchableQuery),
    }))
    .filter(({ score }) => !searchableQuery || score.value > 0)
    .sort((left, right) => {
      if (right.score.value !== left.score.value) {
        return right.score.value - left.score.value;
      }

      return right.item.capturedAt.getTime() - left.item.capturedAt.getTime();
    });

  return ranked.map(({ item, score }) =>
    decorateInventoryResult(item, searchableQuery, score.reasons),
  );
}

export function generateInventoryMetadata(input: InventoryMetadataInput): {
  category: InventoryCategory | null;
  tags: string[];
  aliases: string[];
  searchText: string;
  metadata: Record<string, unknown>;
} {
  const imageTextValues = inventoryImageTextValues(input.images);
  const audioTextValues = inventoryAudioTextValues(input.audioNotes);
  const assetTextValues = inventoryAssetTextValues(input.assets ?? []);
  const sourceText = [
    input.title,
    input.note,
    input.captureText,
    input.containerLabel,
    input.containerReferenceId,
    input.containerLocationName,
    ...imageTextValues,
    ...audioTextValues,
    ...assetTextValues,
  ]
    .filter(Boolean)
    .join(" ");
  const tags = new Set<string>();
  const aliases = new Set<string>();
  let derivedCategory: InventoryCategory | null = null;

  for (const rule of metadataRules) {
    if (!rule.terms.test(sourceText)) {
      continue;
    }

    derivedCategory ??= rule.category;
    for (const tag of rule.tags) {
      tags.add(tag);
    }
    for (const alias of rule.aliases) {
      aliases.add(alias);
    }
  }

  const category = input.selectedCategory ?? derivedCategory;

  const searchText = normalizeSearchText([
    input.title,
    input.note,
    input.captureText,
    input.status,
    input.importance,
    input.kind,
    input.containerLabel,
    input.containerReferenceId,
    input.containerLocationName,
    category,
    input.acquisitionSource,
    formatInventoryCostSearchText(input.costCents),
    ...tags,
    ...aliases,
    ...imageTextValues,
    ...audioTextValues,
    ...assetTextValues,
  ]);

  return {
    category,
    tags: [...tags].sort(),
    aliases: [...aliases].sort(),
    searchText,
    metadata: buildInventoryMetadataRecord(),
  };
}

export function buildInventoryItemSearchTextForContainer(
  item: Pick<
    InventoryItemRecord,
    | "acquisitionSource"
    | "aliases"
    | "assets"
    | "audioNotes"
    | "captureText"
    | "category"
    | "costCents"
    | "images"
    | "importance"
    | "kind"
    | "note"
    | "remedyProfile"
    | "status"
    | "tags"
    | "title"
  >,
  container: {
    location?: { name: string } | null;
    name: string;
    referenceId: string;
  },
): string {
  return normalizeSearchText([
    item.title,
    item.note,
    item.captureText,
    item.status,
    item.importance,
    item.kind,
    container.name,
    container.referenceId,
    container.location?.name,
    item.category,
    item.acquisitionSource,
    formatInventoryCostSearchText(item.costCents),
    ...item.tags,
    ...item.aliases,
    ...inventoryImageTextValues(item.images),
    ...inventoryAudioTextValues(item.audioNotes ?? []),
    ...inventoryAssetTextValues(item.assets ?? []),
    ...inventoryRemedyProfileSearchTextValues(item.remedyProfile),
  ]);
}

export function buildInventoryItemSearchText(
  item: Pick<
    InventoryItemRecord,
    | "acquisitionSource"
    | "aliases"
    | "assets"
    | "audioNotes"
    | "captureText"
    | "category"
    | "costCents"
    | "images"
    | "importance"
    | "kind"
    | "note"
    | "placements"
    | "remedyProfile"
    | "status"
    | "tags"
    | "title"
  >,
): string {
  const placementText = (item.placements ?? []).flatMap((placement) => [
    placement.note,
    placement.location?.name,
    placement.container?.name,
    placement.container?.referenceId,
    placement.container?.location?.name,
  ]);

  return normalizeSearchText([
    item.title,
    item.note,
    item.captureText,
    item.status,
    item.importance,
    item.kind,
    item.category,
    item.acquisitionSource,
    formatInventoryCostSearchText(item.costCents),
    ...item.tags,
    ...item.aliases,
    ...placementText,
    ...inventoryImageTextValues(item.images),
    ...inventoryAudioTextValues(item.audioNotes ?? []),
    ...inventoryAssetTextValues(item.assets ?? []),
    ...inventoryRemedyProfileSearchTextValues(item.remedyProfile),
  ]);
}

function inventoryRemedyProfileSearchTextValues(
  profile: InventoryRemedyProfileRecord | null | undefined,
): Array<string | null | undefined> {
  if (!profile) {
    return [];
  }

  return [
    profile.selectionSummary,
    ...profile.potencies,
    ...profile.externalReferences.flatMap((reference) => [
      reference.source,
      reference.referenceId,
      reference.url,
    ]),
  ];
}

export function formatInventoryWhere(item: {
  locationName: string | null;
  container?: InventoryContainerRecord | null;
  containerLabel: string | null;
  placements?: InventoryItemPlacementRecord[];
}): string {
  if (item.placements && item.placements.length > 0) {
    return item.placements
      .map((placement) => `${formatInventoryPlacementLabel(placement)} × ${placement.quantity}`)
      .join(" · ");
  }

  const containerLabel = formatInventoryContainerLabel(item.container ?? null);
  const containerLocationName = item.container?.location?.name ?? null;

  if (containerLocationName && containerLabel) {
    return `${containerLocationName} / ${containerLabel}`;
  }

  return containerLabel ?? "Unplaced";
}

export function formatInventoryPlacementLabel(
  placement: Pick<
    InventoryItemPlacementRecord,
    "container" | "location" | "note"
  >,
): string {
  const containerLabel = formatInventoryContainerLabel(
    placement.container ?? null,
    placement.location?.name ?? placement.note ?? "Unplaced",
  );

  if (placement.container?.location?.name && containerLabel) {
    return `${placement.container.location.name} / ${containerLabel}`;
  }

  return containerLabel ?? "Unplaced";
}

export function formatInventoryEstimatedValue(
  costCents: number | null,
  costCurrency: string,
): string | null {
  if (costCents === null) {
    return null;
  }

  return `${costCurrency.toUpperCase()} ${(costCents / 100).toFixed(2)}`;
}

export function formatInventoryContainerLabel(
  container: InventoryContainerRecord | null,
  fallbackLabel: string | null = null,
): string | null {
  if (container) {
    return `${container.name} (${container.referenceId})`;
  }

  return fallbackLabel;
}

export function normalizeInventoryLocationName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeInventoryContainerName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function readInventoryItemManualFieldLocks(
  metadata: Record<string, unknown>,
): InventoryItemManualField[] {
  const value = metadata[INVENTORY_ITEM_MANUAL_FIELD_LOCKS_METADATA_KEY];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isInventoryItemManualField);
}

function isInventoryItemManualField(
  value: unknown,
): value is InventoryItemManualField {
  return (
    typeof value === "string" &&
    INVENTORY_ITEM_MANUAL_FIELDS.has(value as InventoryItemManualField)
  );
}

const INVENTORY_ITEM_MANUAL_FIELDS =
  new Set<InventoryItemManualField>([
    "acquisitionSource",
    "aliases",
    "captureText",
    "category",
    "costCents",
    "costCurrency",
    "importance",
    "kind",
    "note",
    "status",
    "tags",
    "title",
  ]);

function updateManualFieldLocks(
  existing: InventoryItemRecord,
  input: UpdateInventoryItemInput,
  updated: Record<InventoryItemManualField, unknown>,
): InventoryItemManualField[] {
  const locks = new Set(readInventoryItemManualFieldLocks(existing.metadata));
  const existingValues: Record<InventoryItemManualField, unknown> = {
    acquisitionSource: existing.acquisitionSource,
    aliases: existing.aliases,
    captureText: existing.captureText ?? null,
    category: existing.category,
    costCents: existing.costCents,
    costCurrency: existing.costCurrency,
    importance: existing.importance,
    kind: existing.kind,
    note: existing.note,
    status: existing.status,
    tags: existing.tags,
    title: existing.title,
  };
  const submittedFields: Partial<
    Record<InventoryItemManualField, boolean>
  > = {
    acquisitionSource: input.acquisitionSource !== undefined,
    aliases: input.aliases !== undefined && input.aliases !== null,
    captureText: input.captureText !== undefined,
    category: input.category !== undefined,
    costCents: input.costCents !== undefined,
    costCurrency: input.costCurrency !== undefined,
    importance: input.importance !== undefined && input.importance !== null,
    kind: input.kind !== undefined && input.kind !== null,
    note: input.note !== undefined,
    status: input.status !== undefined && input.status !== null,
    tags: input.tags !== undefined && input.tags !== null,
    title: input.title !== undefined,
  };

  for (const field of INVENTORY_ITEM_MANUAL_FIELDS) {
    if (
      submittedFields[field] &&
      !inventoryValuesEqual(existingValues[field], updated[field])
    ) {
      locks.add(field);
    }
  }

  return [...locks].sort();
}

function inventoryValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  return left === right;
}

function normalizeInventoryIds(
  values: string[] | null | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map(cleanOptional)
        .filter((value): value is string => value !== null),
    ),
  ];
}

async function requireInventoryItem(
  repository: InventoryArchiveRepository,
  rawId: string | null | undefined,
): Promise<InventoryItemRecord> {
  const id = cleanOptional(rawId);

  if (!id) {
    throw new Error("Inventory item ID is required.");
  }

  const item = await repository.getInventoryItem(id);

  if (!item) {
    throw new Error("Inventory item was not found.");
  }

  return item;
}

function normalizeInventoryStringList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map(cleanOptional)
        .filter((value): value is string => value !== null),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function listInventoryItemFiles(
  item: InventoryItemRecord,
): InventoryItemFileRecord[] {
  return [
    ...item.images.flatMap((image) =>
      image.id ? [toInventoryItemFile("image", image)] : [],
    ),
    ...(item.audioNotes ?? []).flatMap((audioNote) =>
      audioNote.id ? [toInventoryItemFile("audio", audioNote)] : [],
    ),
    ...(item.assets ?? []).flatMap((asset) =>
      asset.id ? [toInventoryItemFile("asset", asset)] : [],
    ),
  ];
}

function selectInventoryItemFiles(
  item: InventoryItemRecord,
  ids: {
    imageIds: string[];
    audioIds: string[];
    assetIds: string[];
  },
): InventoryItemFileRecord[] {
  const requested = new Set([
    ...ids.imageIds.map((id) => `image:${id}`),
    ...ids.audioIds.map((id) => `audio:${id}`),
    ...ids.assetIds.map((id) => `asset:${id}`),
  ]);
  const selected = listInventoryItemFiles(item).filter((file) =>
    requested.has(`${file.kind}:${file.id}`),
  );

  if (selected.length !== requested.size) {
    throw new Error("Selected inventory item asset was not found.");
  }

  return selected;
}

function toInventoryItemFile(
  kind: InventoryItemFileKind,
  file: InventoryItemImageRecord | InventoryItemAudioRecord | InventoryItemAssetRecord,
): InventoryItemFileRecord {
  return {
    id: file.id as string,
    kind,
    filePath: file.filePath,
    originalName: file.originalName ?? null,
    mimeType: file.mimeType ?? null,
    sizeBytes: file.sizeBytes ?? null,
  };
}

async function queueInventoryItemRefresh(
  repository: InventoryRepository,
  item: InventoryItemRecord,
): Promise<void> {
  if (isInventoryPreprocessingRepository(repository)) {
    await queueInventoryPreprocessingCapture(repository, item).catch(
      () => undefined,
    );
  } else if (isInventoryEnrichmentRepository(repository)) {
    await queueInventoryEnrichmentCapture(repository, item).catch(
      () => undefined,
    );
  }
}

function resolveCaptureSession(
  repository: InventoryRepository,
  captureSessionId: string | null | undefined,
): Promise<InventorySessionRecord | null> {
  const sessionId = cleanOptional(captureSessionId);

  if (sessionId) {
    return repository.getCaptureSession(sessionId);
  }

  return repository.getActiveCaptureSession();
}

async function resolveContainerById(
  repository: InventoryRepository,
  containerId: string | null | undefined,
): Promise<InventoryContainerRecord | null> {
  const id = cleanOptional(containerId);

  if (!id) {
    return null;
  }

  if (!hasContainerLookup(repository)) {
    throw new Error("Selected container was not found.");
  }

  const container = await repository.getContainer(id);

  if (!container) {
    throw new Error("Selected container was not found.");
  }

  return container;
}

function hasContainerLookup(
  repository: InventoryRepository,
): repository is InventoryRepository &
  Pick<InventoryContainerRepository, "getContainer"> {
  return "getContainer" in repository && typeof repository.getContainer === "function";
}

function hasContainerReferenceAllocator(
  repository: InventoryContainerRepository,
): repository is InventoryContainerRepository &
  InventoryContainerReferenceAllocator {
  return (
    "allocateContainerReferenceId" in repository &&
    typeof repository.allocateContainerReferenceId === "function"
  );
}

function normalizeContainerSizeLiters(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Container size must be a positive number of liters.");
  }

  return value;
}

function normalizeInventoryCostCents(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Estimated value must be a non-negative whole number of cents.");
  }

  return value;
}

function normalizeInventoryQuantity(
  value: number | null | undefined,
): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    throw new Error("Quantity must be a positive whole number.");
  }

  return value as number;
}

function requireInventoryId(
  value: string | null | undefined,
  label: string,
): string {
  const id = cleanOptional(value);

  if (!id) {
    throw new Error(`${label} is required.`);
  }

  return id;
}


function normalizeInventoryCostCurrency(
  value: string | null | undefined,
): string {
  const currency = cleanOptional(value)?.toUpperCase() ?? "CAD";

  if (currency !== "CAD") {
    throw new Error("Estimated value currency must be CAD.");
  }

  return currency;
}

function formatInventoryCostSearchText(costCents: number | null): string | null {
  if (costCents === null) {
    return null;
  }

  const dollars = Math.floor(costCents / 100);
  const cents = String(costCents % 100).padStart(2, "0");

  return `cad ${dollars}.${cents} ${costCents} cents`;
}

function inferLocationKind(
  name: string | null | undefined,
): InventoryLocationKind {
  const normalized = cleanOptional(name)?.toLowerCase();

  if (!normalized) {
    return "OTHER";
  }

  if (/\b(room|office|kitchen|closet|bedroom|bathroom)\b/.test(normalized)) {
    return "ROOM";
  }

  if (/\b(shelf|rack)\b/.test(normalized)) {
    return "SHELF";
  }

  if (/\b(storage|garage|attic|basement|unit|locker)\b/.test(normalized)) {
    return "STORAGE";
  }

  return "AREA";
}

function normalizeSearchText(values: Array<string | null | undefined>): string {
  const words = new Set<string>();

  for (const value of values) {
    const normalized = normalizeSearchValue(value);

    if (!normalized) {
      continue;
    }

    for (const word of normalized.split(/\s+/)) {
      words.add(word);
    }
  }

  return [...words].join(" ");
}

function inventoryImageTextValues(
  images: InventoryItemImageRecord[],
): Array<string | null | undefined> {
  return images.flatMap((image) => [
    image.originalName,
    image.caption,
    image.ocrText,
  ]);
}

function inventoryAudioTextValues(
  audioNotes: InventoryItemAudioRecord[],
): Array<string | null | undefined> {
  return audioNotes.map((audioNote) => audioNote.originalName);
}

function inventoryAssetTextValues(
  assets: InventoryItemAssetRecord[],
): Array<string | null | undefined> {
  return assets.map((asset) => asset.originalName);
}

function buildInventoryMetadataRecord(): InventoryGeneratedMetadata {
  return {
    futureHooks: { ...INVENTORY_METADATA_FUTURE_HOOKS },
    generator: INVENTORY_METADATA_GENERATOR,
    schemaVersion: INVENTORY_METADATA_SCHEMA_VERSION,
    sourceFields: [...INVENTORY_METADATA_SOURCE_FIELDS],
  };
}

function normalizeInventoryImage(
  image: InventoryItemImageRecord,
): InventoryItemImageRecord | null {
  const filePath = cleanOptional(image.filePath);

  if (!filePath) {
    return null;
  }

  return {
    filePath,
    originalName: cleanOptional(image.originalName),
    mimeType: cleanOptional(image.mimeType),
    sizeBytes: image.sizeBytes ?? null,
    width: image.width ?? null,
    height: image.height ?? null,
    caption: cleanOptional(image.caption),
    ocrText: cleanOptional(image.ocrText),
  };
}

function normalizeInventoryAudio(
  audioNote: InventoryItemAudioRecord,
): InventoryItemAudioRecord | null {
  const filePath = cleanOptional(audioNote.filePath);

  if (!filePath) {
    return null;
  }

  return {
    filePath,
    originalName: cleanOptional(audioNote.originalName),
    mimeType: cleanOptional(audioNote.mimeType),
    sizeBytes: audioNote.sizeBytes ?? null,
  };
}

function normalizeInventoryAsset(
  asset: InventoryItemAssetRecord,
): InventoryItemAssetRecord | null {
  const filePath = cleanOptional(asset.filePath);

  if (!filePath) {
    return null;
  }

  return {
    filePath,
    originalName: cleanOptional(asset.originalName),
    mimeType: cleanOptional(asset.mimeType),
    sizeBytes: asset.sizeBytes ?? null,
  };
}

function normalizeSearchValue(value: string | null | undefined): string | null {
  const normalized = normalizeInventorySearchText(value);

  return normalized || null;
}

function joinSearchValues(values: Array<string | null | undefined>): string {
  return buildInventorySearchCorpus(values);
}

function scoreInventoryItem(
  item: InventoryItemRecord,
  query: string | null,
): { value: number; reasons: string[] } {
  const terms = inventorySearchTerms(query);

  if (terms.length === 0) {
    return { value: 1, reasons: ["recent capture"] };
  }

  const fields: InventoryScoreField[] = [
    {
      name: "location",
      value: joinSearchValues([
        item.container?.location?.name,
        item.locationName,
        ...(item.placements ?? []).map(
          (placement) => placement.container?.location?.name,
        ),
      ]),
    },
    {
      name: "container",
      value: joinSearchValues([
        item.containerLabel,
        item.container?.name,
        item.container?.referenceId,
        ...(item.placements ?? []).flatMap((placement) => [
          placement.note,
          placement.container?.name,
          placement.container?.referenceId,
        ]),
      ]),
    },
    { name: "title", value: item.title },
    { name: "note", value: item.note },
    { name: "tag", value: item.tags.join(" ") },
    { name: "alias", value: item.aliases.join(" ") },
    {
      name: "photo",
      value: joinSearchValues(inventoryImageTextValues(item.images)),
    },
    { name: "search text", value: item.searchText },
  ];
  const searchable = buildInventorySearchCorpus(
    fields.map((field) => field.value),
  );

  if (!matchesInventorySearchQuery(searchable, query)) {
    return { value: 0, reasons: [] };
  }

  const normalizedQuery = normalizeInventorySearchText(query);
  const reasons = new Set<string>();
  let value = 0;

  for (const field of fields) {
    const normalizedField = normalizeInventorySearchText(field.value);

    if (!normalizedField) {
      continue;
    }

    if (normalizedField.includes(normalizedQuery)) {
      value += field.name === "alias" ? 100 : 50;
      reasons.add(field.name);
      continue;
    }

    const termMatches = terms.filter((term) =>
      normalizedField.includes(term),
    ).length;

    if (termMatches > 0) {
      value += termMatches * (field.name === "alias" ? 12 : 8);
      reasons.add(field.name);
    }
  }

  return { value, reasons: [...reasons] };
}

function decorateInventoryResult(
  item: InventoryItemRecord,
  query: string | null,
  reasons: string[] = [],
): InventorySearchResult {
  let matchFields: string[];

  if (reasons.length > 0) {
    matchFields = reasons;
  } else if (query) {
    matchFields = ["search text"];
  } else {
    matchFields = [];
  }

  const matchExplanation =
    matchFields.length > 0
      ? `Matched ${matchFields.join(", ")}`
      : "Recent capture";

  return {
    ...item,
    whereLabel: formatInventoryWhere(item),
    matchExplanation,
    matchFields,
  };
}
