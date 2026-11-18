import { inventorySecondaryButton } from "../../inventory-button-styles";
import { Box, Button, Flex } from "@chakra-ui/react";
import {
  containerHeader,
  containerPage,
  detailAction,
  sceneBody,
  sceneSection,
} from "../container-layout";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  deleteInventoryContainerAction,
  moveInventoryItemsAction,
  updateInventoryContainerAction,
} from "../../actions";
import {
  getInventoryContainer,
  getInventoryContainerContents,
  isApiNotFoundError,
  listInventoryContainerVisuals,
} from "@/lib/quantself-api-client";
import { ContainerVisual } from "../container-visual";
import type { ContainerShelf } from "../types";
import { ContainerDetailEdit } from "./container-detail-edit";
import { ContainerRetrievalActions } from "./container-retrieval-actions";
import InventoryContainerLoading from "./loading";

type ContainerPageProps = {
  params: Promise<{ containerId: string }>;
};

export const dynamic = "force-dynamic";

export default function InventoryContainerPage({ params }: ContainerPageProps) {
  return (
    <Suspense fallback={<InventoryContainerLoading />}>
      <InventoryContainerContent params={params} />
    </Suspense>
  );
}

async function InventoryContainerContent({ params }: ContainerPageProps) {
  const { containerId } = await params;
  let container;
  let contents;
  let visuals;

  try {
    [container, contents, visuals] = await Promise.all([
      getInventoryContainer(containerId),
      getInventoryContainerContents(containerId),
      listInventoryContainerVisuals(),
    ]);
  } catch (error) {
    if (isApiNotFoundError(error)) {
      notFound();
    }

    throw error;
  }

  const { editableVisuals, visualPresets } = visuals;
  const items = contents.items;

  const editableVisual = editableVisuals.find(
    (visual) => visual.key === container.visualPreset.id,
  );
  const containerShelf: ContainerShelf = {
    hoverBounds: editableVisual?.hoverBounds ?? container.visualPreset.bounds,
    id: container.id,
    itemCount: items.length,
    items,
    location: container.location?.name ?? "Unplaced",
    name: container.name,
    referenceId: container.referenceId,
    visualPreset: {
      ...container.visualPreset,
      bounds: editableVisual?.bounds ?? container.visualPreset.bounds,
    },
    visualPresetKey: container.visualPresetKey,
  };

  return (
    <Box as="main" {...containerPage}>
      <Box as="header" {...containerHeader}>
        <Flex w="full" wrap="wrap" align="center" justify="end" gap="2">
          <ContainerRetrievalActions
            candidates={contents.retrievalCandidates.map((item) => ({
              id: item.id,
              title: item.title,
              where: item.where,
            }))}
            containerId={container.id}
            labelUrl={`/inventory/containers/${container.id}/label`}
            moveAction={moveInventoryItemsAction}
          >
            <Button
              {...detailAction}
              asChild
              {...inventorySecondaryButton}
              bg="bg"
            >
              <Link href="/inventory/containers">
                <ArrowLeftIcon />
                Containers
              </Link>
            </Button>
            <ContainerDetailEdit
              container={{
                id: container.id,
                itemCount: items.length,
                locationName: container.location?.name ?? null,
                name: container.name,
                referenceId: container.referenceId,
                sizeLiters: container.sizeLiters,
                visualPresetKey: container.visualPresetKey,
              }}
              deleteAction={deleteInventoryContainerAction}
              updateAction={updateInventoryContainerAction}
              visualPresets={visualPresets.map((preset) => ({
                id: preset.id,
                isDefault: preset.isDefault,
                name: preset.name,
              }))}
            />
          </ContainerRetrievalActions>
        </Flex>
      </Box>

      <Flex
        as="section"
        aria-label={`${container.name} contents`}
        {...sceneSection}
      >
        <Flex {...sceneBody}>
          <ContainerVisual
            container={containerShelf}
            layoutSeed={crypto.randomUUID()}
            linkTitle={false}
            mode="scroll"
            priority
          />
        </Flex>
      </Flex>
    </Box>
  );
}
