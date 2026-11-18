"use client";

import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Input,
  Spinner,
  Text,
  chakra,
} from "@chakra-ui/react";
import {
  itemDestructiveButton,
  itemButton,
} from "./inventory-item-button-styles";
import { FileIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { AudioPlayer } from "@/components/audio-player";

import {
  deleteInventoryItemMediaFromBrowser,
  inventoryItemMediaContentPath,
  inventoryItemMediaFilesSignature,
  type BrowserInventoryItemMedia,
  uploadInventoryItemMediaFromBrowser,
} from "@/lib/quantself-api-browser";

export function InventoryItemMediaManager({
  media,
  itemId,
}: {
  media: BrowserInventoryItemMedia[];
  itemId: string;
}) {
  const router = useRouter();
  const uploadAttemptRef = useRef<{ key: string; signature: string } | null>(
    null,
  );
  const removalKeysRef = useRef(new Map<string, string>());
  const [state, setState] = useState<{
    message: string;
    status: "idle" | "success" | "error";
  }>({
    message: "",
    status: "idle",
  });
  const [uploadPending, startUploadTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const audioNotes = media.filter((entry) => entry.kind === "audio");
  const assets = media.filter((entry) => entry.kind === "asset");

  function uploadMedia(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const files = formData
      .getAll("files")
      .filter(
        (value): value is File => value instanceof File && value.size > 0,
      );

    startUploadTransition(async () => {
      if (files.length === 0) {
        setState({ message: "Choose at least one file.", status: "error" });
        return;
      }

      try {
        const signature = inventoryItemMediaFilesSignature(files);
        let attempt = uploadAttemptRef.current;

        if (!attempt || attempt.signature !== signature) {
          attempt = { key: crypto.randomUUID(), signature };
          uploadAttemptRef.current = attempt;
        }

        await uploadInventoryItemMediaFromBrowser(itemId, files, {
          idempotencyKey: attempt.key,
        });
        uploadAttemptRef.current = null;
        form.reset();
        setState({
          message: `${files.length} file${files.length === 1 ? "" : "s"} added.`,
          status: "success",
        });
        router.refresh();
      } catch (error) {
        setState({
          message:
            error instanceof Error && error.message
              ? error.message
              : "Could not add files.",
          status: "error",
        });
      }
    });
  }

  function removeMedia(mediaId: string) {
    if (uploadPending || removePending) {
      return;
    }

    startRemoveTransition(async () => {
      try {
        const idempotencyKey =
          removalKeysRef.current.get(mediaId) ?? crypto.randomUUID();
        removalKeysRef.current.set(mediaId, idempotencyKey);
        await deleteInventoryItemMediaFromBrowser(itemId, mediaId, {
          idempotencyKey,
        });
        removalKeysRef.current.delete(mediaId);
        setState({ message: "Media removed.", status: "success" });
        router.refresh();
      } catch (error) {
        setState({
          message:
            error instanceof Error && error.message
              ? error.message
              : "Could not remove media.",
          status: "error",
        });
      }
    });
  }

  return (
    <chakra.section display="grid" gap="4" aria-label="Item Media">
      <Flex
        flexWrap="wrap"
        alignItems="end"
        justifyContent="space-between"
        gap="3"
      >
        <div>
          <chakra.h3 fontWeight="medium" fontSize="sm">
            Media
          </chakra.h3>
          <Text color="fg.muted" fontSize="xs">
            Upload audio notes, documents, and other files directly to the API.
          </Text>
        </div>
        <chakra.form
          display="flex"
          flexWrap="wrap"
          alignItems="end"
          gap="2"
          onSubmit={uploadMedia}
        >
          <Input
            size="sm"
            minW="0"
            rounded="l2"
            borderColor="border"
            aria-label="Choose Item Media"
            css={{
              "&::file-selector-button": {
                bg: "bg.muted",
                color: "fg",
                fontWeight: "medium",
                borderRadius: "l1",
                marginInlineEnd: "2",
                px: "2",
                py: "1",
              },
            }}
            multiple
            name="files"
            type="file"
          />
          <Button
            {...itemButton}
            aria-busy={uploadPending}
            disabled={uploadPending}
            type="submit"
          >
            {uploadPending && <Spinner size="xs" />}
            <UploadIcon />
            Add files
          </Button>
        </chakra.form>
      </Flex>

      {audioNotes.length === 0 && assets.length === 0 ? (
        <Text
          borderRadius="0.875rem"
          borderWidth="1px"
          borderStyle="dashed"
          p="4"
          color="fg.muted"
          fontSize="sm"
        >
          No Item Media beyond images yet.
        </Text>
      ) : (
        <Grid gap="4">
          {audioNotes.length > 0 ? (
            <chakra.section display="grid" gap="2" aria-label="Item audio">
              <chakra.h3 fontWeight="medium" fontSize="sm">
                Audio
              </chakra.h3>
              <Grid gap="3">
                {audioNotes.map((audio, index) => (
                  <chakra.article
                    display="grid"
                    gap="2"
                    borderRadius="0.875rem"
                    borderWidth="1px"
                    borderColor="border"
                    bg="bg.muted/20"
                    p="3"
                    key={audio.id}
                  >
                    <Flex
                      alignItems="start"
                      justifyContent="space-between"
                      gap="3"
                    >
                      <Text fontWeight="medium" fontSize="sm">
                        {audio.originalName ?? `Audio note ${index + 1}`}
                      </Text>
                      <Button
                        {...itemDestructiveButton}
                        disabled={uploadPending || removePending}
                        onClick={() => removeMedia(audio.id)}

                        type="button"
                      >
                        Remove
                      </Button>
                    </Flex>
                    <AudioPlayer
                      label={audio.originalName ?? `audio note ${index + 1}`}
                      src={inventoryItemMediaContentPath(itemId, audio.id)}
                    />
                  </chakra.article>
                ))}
              </Grid>
            </chakra.section>
          ) : null}

          {assets.length > 0 ? (
            <chakra.section display="grid" gap="2" aria-label="Item files">
              <chakra.h3 fontWeight="medium" fontSize="sm">
                Files
              </chakra.h3>
              <chakra.ul display="grid" gap="2">
                {assets.map((asset, index) => (
                  <chakra.li
                    display="flex"
                    minW="0"
                    alignItems="center"
                    justifyContent="space-between"
                    gap="3"
                    borderRadius="0.875rem"
                    borderWidth="1px"
                    borderColor="border"
                    bg="bg.muted/20"
                    p="3"
                    key={asset.id}
                  >
                    <Box minW="0">
                      <chakra.a
                        display="block"
                        truncate
                        fontWeight="medium"
                        fontSize="sm"
                        textUnderlineOffset="4px"
                        css={{ _hover: { textDecoration: "underline" } }}
                        href={inventoryItemMediaContentPath(itemId, asset.id)}
                        target="_blank"
                      >
                        {asset.originalName ?? `File ${index + 1}`}
                      </chakra.a>
                      <Text color="fg.muted" fontSize="xs">
                        {asset.contentType ?? "File"}
                      </Text>
                    </Box>
                    <Flex alignItems="center" gap="2">
                      <Badge
                        borderRadius="full"
                        size="sm"
                        flexShrink={0}
                        w="fit-content"
                        variant="outline"
                      >
                        {formatFileSize(asset.sizeBytes ?? null)}
                      </Badge>
                      <Button
                        {...itemDestructiveButton}
                        disabled={uploadPending || removePending}
                        onClick={() => removeMedia(asset.id)}

                        type="button"
                      >
                        Remove
                      </Button>
                    </Flex>
                  </chakra.li>
                ))}
              </chakra.ul>
            </chakra.section>
          ) : null}
        </Grid>
      )}

      <Text
        aria-live="polite"
        minH="5"
        fontSize="sm"
        color={state.status === "error" ? "fg.error" : "fg.muted"}
      >
        {uploadPending
          ? "Uploading files…"
          : removePending
            ? "Removing media…"
            : state.message}
      </Text>
    </chakra.section>
  );
}

function formatFileSize(sizeBytes: number | null): string {
  if (sizeBytes === null || sizeBytes < 0) {
    return "Unknown size";
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
