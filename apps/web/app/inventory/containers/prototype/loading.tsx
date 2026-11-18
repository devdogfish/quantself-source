import { Flex, Grid, Skeleton } from "@chakra-ui/react";
import { LoadingRegion } from "@/components/loading-region";
import styles from "./prototype.module.css";

export default function ContainerPrototypeLoading() {
  return (
    <LoadingRegion
      className={styles.prototype}
      label="Loading container prototype"
    >
      <header className={styles.stickyHeader}>
        <Skeleton h="10" w="full" maxW="28rem" rounded="full" />
      </header>
      <Flex as="section" className={styles.stackSlide}>
        <Grid mx="auto" w="full" maxW="1600px" gap="3">
          <Skeleton h="3" w="20" />
          <Skeleton h="min(68svh, 42rem)" w="full" rounded="2rem" />
        </Grid>
      </Flex>
    </LoadingRegion>
  );
}
