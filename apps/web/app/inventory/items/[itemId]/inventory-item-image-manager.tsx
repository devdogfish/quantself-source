"use client";

import {
  Button,
  Flex,
  Grid,
  Icon,
  Image,
  IconButton,
  Spinner,
  Text,
  chakra,
} from "@chakra-ui/react";
import {
  itemDestructiveButton,
  itemSecondaryButton,
} from "./inventory-item-button-styles";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, ImagePlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";

import {
  deleteInventoryItemMediaFromBrowser,
  inventoryItemMediaContentPath,
  inventoryItemMediaFilesSignature,
  reorderInventoryItemImagesFromBrowser,
  uploadInventoryItemMediaFromBrowser,
} from "@/lib/quantself-api-browser";
import type { InventoryItemMutationState } from "./inventory-item-controls";

export type InventoryItemImage = {
  caption: string | null;
  id: string;
  url: string;
};

const initialState: InventoryItemMutationState = {
  message: "",
  status: "idle",
};

export function InventoryItemImageManager({
  images,
  itemId,
  title,
}: {
  images: InventoryItemImage[];
  itemId: string;
  title: string;
}) {
  const router = useRouter();
  const dragContextId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInFlightRef = useRef(false);
  const uploadAttemptRef = useRef<{ key: string; signature: string } | null>(
    null,
  );
  const orderAttemptRef = useRef<{ key: string; signature: string } | null>(
    null,
  );
  const removalKeysRef = useRef(new Map<string, string>());
  const [orderedImages, setOrderedImages] = useState(images);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadState, setUploadState] = useState(initialState);
  const [orderState, setOrderState] = useState(initialState);
  const [uploadPending, startUploadTransition] = useTransition();
  const [orderPending, startOrderTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function uploadImages(files: File[]) {
    const imageFiles = files.filter(isImageFile);

    if (imageFiles.length === 0) {
      setUploadState({
        status: "error",
        message: "Choose at least one image file.",
      });
      return;
    }

    if (uploadInFlightRef.current || orderPending || removePending) {
      return;
    }

    uploadInFlightRef.current = true;
    setUploadState(initialState);

    startUploadTransition(async () => {
      try {
        const signature = inventoryItemMediaFilesSignature(imageFiles);
        let attempt = uploadAttemptRef.current;

        if (!attempt || attempt.signature !== signature) {
          attempt = { key: crypto.randomUUID(), signature };
          uploadAttemptRef.current = attempt;
        }

        const uploadedMedia = await uploadInventoryItemMediaFromBrowser(
          itemId,
          imageFiles,
          { idempotencyKey: attempt.key },
        );
        uploadAttemptRef.current = null;
        setOrderedImages((current) => [
          ...current,
          ...uploadedMedia.flatMap((entry) =>
            entry.kind === "image" && !current.some(({ id }) => id === entry.id)
              ? [
                  {
                    caption: entry.originalName,
                    id: entry.id,
                    url: inventoryItemMediaContentPath(itemId, entry.id),
                  },
                ]
              : [],
          ),
        ]);
        setUploadState({
          status: "success",
          message: `${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"} added.`,
        });
        router.refresh();
      } catch (error) {
        setUploadState({
          status: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Could not add images.",
        });
      } finally {
        uploadInFlightRef.current = false;
      }
    });
  }

  function openImagePicker() {
    fileInputRef.current?.click();
  }

  function hasFiles(event: React.DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (!hasFiles(event)) {
      return;
    }

    event.preventDefault();
    setIsDragActive(false);
    uploadImages(Array.from(event.dataTransfer.files));
  }

  function handleFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    uploadImages(files);
  }

  function reorderImages(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;

    if (
      !overId ||
      activeId === overId ||
      uploadPending ||
      orderPending ||
      removePending
    ) {
      return;
    }

    const previous = orderedImages;
    const from = previous.findIndex(({ id }) => id === activeId);
    const to = previous.findIndex(({ id }) => id === overId);

    if (from < 0 || to < 0) {
      return;
    }

    const next = arrayMove(previous, from, to);
    const signature = JSON.stringify(next.map(({ id }) => id));
    let attempt = orderAttemptRef.current;

    if (!attempt || attempt.signature !== signature) {
      attempt = { key: crypto.randomUUID(), signature };
      orderAttemptRef.current = attempt;
    }

    setOrderedImages(next);
    setOrderState(initialState);

    startOrderTransition(async () => {
      try {
        await reorderInventoryItemImagesFromBrowser(
          itemId,
          next.map((image) => image.id),
          { idempotencyKey: attempt.key },
        );
        orderAttemptRef.current = null;
        setOrderState({ status: "success", message: "Image order saved." });
        router.refresh();
      } catch (error) {
        setOrderedImages(previous);
        setOrderState({
          status: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Could not save image order.",
        });
      }
    });
  }

  function removeImage(imageId: string) {
    if (uploadPending || orderPending || removePending) {
      return;
    }

    const previous = orderedImages;
    const next = previous.filter((image) => image.id !== imageId);
    setOrderedImages(next);
    setUploadState(initialState);
    setOrderState(initialState);

    startRemoveTransition(async () => {
      try {
        const idempotencyKey =
          removalKeysRef.current.get(imageId) ?? crypto.randomUUID();
        removalKeysRef.current.set(imageId, idempotencyKey);
        await deleteInventoryItemMediaFromBrowser(itemId, imageId, {
          idempotencyKey,
        });
        removalKeysRef.current.delete(imageId);
        setUploadState({ status: "success", message: "Image removed." });
        router.refresh();
      } catch (error) {
        setOrderedImages(previous);
        setUploadState({
          status: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Could not remove image.",
        });
      }
    });
  }

  return (
    <chakra.section
      aria-label="Item Images"
      display="grid"
      gap="3"
      css={{
        "&[data-drag-active]": {
          borderRadius: "2xl",
          outline: "2px solid",
          outlineColor: "brand.solid/70",
          _motionSafe: { scale: ".99", transition: "transform .15s" },
          _motionReduce: { bg: "brand.solid/5" },
        },
      }}
      data-item-image-drop-target=""
      data-drag-active={isDragActive ? "" : undefined}
      onDragEnter={(event) => {
        if (hasFiles(event)) {
          event.preventDefault();
          setIsDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Element) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setIsDragActive(false);
        }
      }}
      onDragOver={(event) => {
        if (hasFiles(event)) {
          event.preventDefault();
        }
      }}
      onDrop={handleDrop}
    >
      <chakra.span srOnly>
        <input
          accept="image/gif,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          aria-label="Choose Item Images"
          multiple
          onChange={handleFileSelection}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      </chakra.span>

      {orderedImages.length === 0 ? (
        <chakra.button
          aria-label="Add images"
          display="grid"
          minH="56"
          w="full"
          placeItems="center"
          borderRadius="0.875rem"
          borderWidth="2px"
          borderStyle="dashed"
          borderColor="border"
          p="8"
          color="fg.muted"
          transitionProperty="colors"
          focusVisibleRing="outside"
          focusRingColor="brand.focusRing"
          css={{ _hover: { borderColor: "brand.solid", bg: "brand.solid/5" } }}
          disabled={uploadPending}
          onClick={openImagePicker}
          type="button"
        >
          <chakra.span display="grid" justifyItems="center" gap="3">
            <Icon as={ImagePlusIcon} boxSize="10" />
            <chakra.span fontSize="sm" fontWeight="medium" color="fg">
              {uploadPending ? "Adding images…" : "Add images"}
            </chakra.span>
            <chakra.span fontSize="sm">
              Drop images here or choose files
            </chakra.span>
          </chakra.span>
        </chakra.button>
      ) : orderedImages.length === 1 ? (
        <chakra.figure
          className="group"
          position="relative"
          overflow="hidden"
          borderRadius="0.875rem"
          borderWidth="1px"
          borderColor="border"
          bg="bg.muted/20"
          data-item-single-image=""
        >
          <chakra.a
            aria-label={`View full image of ${title}`}
            display="block"
            href={orderedImages[0].url}
            rel="noreferrer"
            target="_blank"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- private Item Image route. */}
            <Image
              alt={`${title}, image 1 of 1`}
              maxH="70vh"
              w="full"
              objectFit="contain"
              transitionProperty="filter"
              css={{
                _groupHover: { filter: "brightness(.75)" },
                _groupFocusWithin: { filter: "brightness(.75)" },
                _motionReduce: { transition: "none" },
              }}
              src={orderedImages[0].url}
            />
          </chakra.a>
          <Button
            size="sm"
            h="20"
            w="20"
            px="2.5"
            aria-busy={uploadPending}
            disabled={uploadPending}
            aria-label="Add images"
            position="absolute"
            inset="0"
            m="auto"
            borderRadius="full"
            opacity={0}
            boxShadow="lg"
            transitionProperty="opacity"
            css={{
              "& svg": { width: "8", height: "8" },
              _groupHover: { opacity: 1 },
              _groupFocusWithin: { opacity: 1 },
              "@media (pointer: coarse)": { opacity: 1 },
            }}
            onClick={openImagePicker}
            type="button"
          >
            {uploadPending && <Spinner size="xs" />}
            <ImagePlusIcon />
          </Button>
          <Button
            {...itemDestructiveButton}
            aria-label="Remove image 1"
            position="absolute"
            bottom="3"
            right="3"
            boxShadow="lg"
            disabled={uploadPending || orderPending || removePending}
            onClick={() => removeImage(orderedImages[0].id)}

            type="button"
          >
            Remove
          </Button>
        </chakra.figure>
      ) : (
        <Grid gap="3">
          <DndContext
            id={dragContextId}
            collisionDetection={closestCenter}
            onDragEnd={reorderImages}
            sensors={sensors}
          >
            <SortableContext
              items={orderedImages.map(({ id }) => id)}
              strategy={rectSortingStrategy}
            >
              <Grid
                gridTemplateColumns="repeat(auto-fit, minmax(min(100%, max(14rem, calc(33.333% - 0.5rem))), 1fr))"
                gap="3"
              >
                {orderedImages.map((image, index) => (
                  <SortableImage
                    image={image}
                    index={index}
                    key={image.id}
                    primary={index === 0}
                    removeDisabled={
                      uploadPending || orderPending || removePending
                    }
                    onRemove={removeImage}
                    title={title}
                    total={orderedImages.length}
                  />
                ))}
                <chakra.button
                  aria-label="Add images"
                  display="grid"
                  aspectRatio="4 / 3"
                  placeItems="center"
                  borderRadius="0.875rem"
                  borderWidth="2px"
                  borderStyle="dashed"
                  borderColor="border"
                  color="fg.muted"
                  transitionProperty="colors"
                  focusVisibleRing="outside"
                  focusRingColor="brand.focusRing"
                  css={{
                    _hover: { borderColor: "brand.solid", bg: "brand.solid/5" },
                  }}
                  data-item-image-add-tile=""
                  disabled={uploadPending}
                  onClick={openImagePicker}
                  type="button"
                >
                  <chakra.span display="grid" justifyItems="center" gap="2">
                    <Icon as={ImagePlusIcon} boxSize="10" />
                    <chakra.span fontSize="sm" fontWeight="medium" color="fg">
                      Add images
                    </chakra.span>
                  </chakra.span>
                </chakra.button>
              </Grid>
            </SortableContext>
          </DndContext>
        </Grid>
      )}

      <Text
        aria-live="polite"
        minH="5"
        fontSize="sm"
        color={
          uploadState.status === "error" || orderState.status === "error"
            ? "fg.error"
            : "fg.muted"
        }
      >
        {uploadPending
          ? "Uploading images…"
          : orderPending
            ? "Saving image order…"
            : removePending
              ? "Removing image…"
              : orderState.message || uploadState.message}
      </Text>
    </chakra.section>
  );
}

function isImageFile(file: File): boolean {
  if (file.size <= 0) {
    return false;
  }

  const mimeType = file.type.trim().toLowerCase();

  if (mimeType && mimeType !== "application/octet-stream") {
    return /^(?:image\/(?:gif|heic|heif|jpeg|png|webp))$/u.test(mimeType);
  }

  return /\.(?:gif|heic|heif|jpe?g|png|webp)$/iu.test(file.name);
}

function SortableImage({
  image,
  index,
  onRemove,
  primary,
  removeDisabled,
  title,
  total,
}: {
  image: InventoryItemImage;
  index: number;
  onRemove: (imageId: string) => void;
  primary: boolean;
  removeDisabled: boolean;
  title: string;
  total: number;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: image.id });

  return (
    <chakra.figure
      asChild
      position="relative"
      display="grid"
      gap="2"
      borderRadius="0.875rem"
      borderWidth="1px"
      borderColor="border"
      bg="bg"
      p="2"
      zIndex={isDragging ? 10 : undefined}
      opacity={isDragging ? 0.7 : undefined}
      boxShadow={isDragging ? "lg" : undefined}
    >
      <figure
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- private Item Image route. */}
        <Image
          alt={`${title}, image ${index + 1} of ${total}`}
          aspectRatio="4 / 3"
          w="full"
          borderRadius="0.625rem"
          objectFit="cover"
          src={image.url}
        />
        <IconButton
          {...itemSecondaryButton}
          aria-label={`Move image ${index + 1}`}
          position="absolute"
          right="3"
          top="3"
          cursor="grab"
          bg="bg.panel"
          boxShadow="sm"
          _active={{ cursor: "grabbing" }}
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon />
        </IconButton>
        <chakra.figcaption
          display="flex"
          minW="0"
          alignItems="center"
          justifyContent="space-between"
          gap="2"
          px="1"
          fontSize="xs"
        >
          <chakra.span truncate color="fg.muted">
            {image.caption ?? `Image ${index + 1}`}
          </chakra.span>
          <Flex alignItems="center" gap="2">
            {primary ? (
              <chakra.span
                flexShrink={0}
                borderRadius="full"
                bg="brand.solid/10"
                px="2"
                py="0.5"
                fontWeight="medium"
                color="brand.fg"
              >
                Primary
              </chakra.span>
            ) : null}
            <Button
              {...itemDestructiveButton}
              aria-label={`Remove image ${index + 1}`}
              disabled={removeDisabled}
              onClick={() => onRemove(image.id)}

              type="button"
            >
              Remove
            </Button>
          </Flex>
        </chakra.figcaption>
      </figure>
    </chakra.figure>
  );
}
