import { inventorySecondaryButton } from "../../inventory-button-styles";
import { Box, Button, Flex, Skeleton } from "@chakra-ui/react";
import {
  containerHeader,
  containerPage,
  detailAction,
  sceneBody,
  sceneSection,
} from "../container-layout";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { LoadingRegion } from "@/components/loading-region";

export default function InventoryContainerLoading() {
  return (
    <Box {...containerPage}>
      <LoadingRegion label="Loading container contents">
        <Box as="header" {...containerHeader}>
          <Flex w="full" wrap="wrap" align="center" justify="end" gap="2">
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
            <Skeleton h="8" w="16" borderRadius="md" />
            <Skeleton h="8" w="24" borderRadius="md" />
          </Flex>
        </Box>
        <Flex as="section" {...sceneSection}>
          <Flex {...sceneBody}>
            <Skeleton
              h="min(68svh, 42rem)"
              w="full"
              maxW="5xl"
              borderRadius="2rem"
            />
          </Flex>
        </Flex>
      </LoadingRegion>
    </Box>
  );
}
