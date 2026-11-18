import type { Metadata } from "next";
import { Grid } from "@chakra-ui/react";
import { JobsPage } from "../jobs-frame";
import { JobsCandidateContext } from "../context/jobs-candidate-context";
import { JobsPrivateDetails } from "../private/jobs-private-details";

export const metadata: Metadata = { title: "Profile · Jobs · Quantself" };

// What agents and the runner know about the Owner: shared answers (encrypted) and the candidate-context document.
export default function JobsProfilePage() {
  return (
    <JobsPage maxW="7xl">
      <Grid templateColumns={{ base: "1fr", xl: "minmax(0, 1fr) minmax(0, 1fr)" }} gap={{ base: "10", xl: "12" }} alignItems="start">
        <JobsPrivateDetails />
        <JobsCandidateContext />
      </Grid>
    </JobsPage>
  );
}
