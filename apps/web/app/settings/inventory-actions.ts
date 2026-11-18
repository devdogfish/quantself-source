"use server";

import { revalidatePath } from "next/cache";
import {
  approveInventoryProposal,
  rejectInventoryProposal,
  updateInventoryEnrichmentSettings,
} from "@/lib/quantself-api-client";

export type InventoryProposalActionState = {
  message: string;
  status: "idle" | "success" | "error";
};

export async function updateInventoryEnrichmentApprovalSettingAction(
  formData: FormData,
): Promise<void> {
  await updateInventoryEnrichmentSettings({
    approvalsRequired: formData.get("autoApproveFuture") !== "on",
  });
  revalidatePath("/settings");
}

export async function updateInventoryEnrichmentApprovalSettingWithStateAction(
  _state: InventoryProposalActionState,
  formData: FormData,
): Promise<InventoryProposalActionState> {
  try {
    await updateInventoryEnrichmentApprovalSettingAction(formData);

    return { message: "Approval setting saved.", status: "success" };
  } catch (error) {
    return proposalActionError(error, "Could not save approval setting.");
  }
}

export async function approveInventoryEnrichmentProposalAction(
  formData: FormData,
): Promise<void> {
  const jobId = formString(formData, "jobId");
  const itemId = formString(formData, "itemId");

  if (jobId) {
    await approveInventoryProposal(jobId);
  }

  revalidatePath("/settings");
  revalidatePath("/inventory");

  if (itemId) {
    revalidatePath(`/inventory/items/${itemId}`);
  }
}

export async function rejectInventoryEnrichmentProposalAction(
  formData: FormData,
): Promise<void> {
  const jobId = formString(formData, "jobId");
  const itemId = formString(formData, "itemId");

  if (jobId) {
    await rejectInventoryProposal(jobId);
  }

  revalidatePath("/settings");
  revalidatePath("/inventory");

  if (itemId) {
    revalidatePath(`/inventory/items/${itemId}`);
  }
}

export async function approveInventoryEnrichmentProposalWithStateAction(
  _state: InventoryProposalActionState,
  formData: FormData,
): Promise<InventoryProposalActionState> {
  try {
    await approveInventoryEnrichmentProposalAction(formData);

    return { message: "Proposal approved.", status: "success" };
  } catch (error) {
    return proposalActionError(error, "Could not approve proposal.");
  }
}

export async function rejectInventoryEnrichmentProposalWithStateAction(
  _state: InventoryProposalActionState,
  formData: FormData,
): Promise<InventoryProposalActionState> {
  try {
    await rejectInventoryEnrichmentProposalAction(formData);

    return { message: "Proposal rejected.", status: "success" };
  } catch (error) {
    return proposalActionError(error, "Could not reject proposal.");
  }
}

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function proposalActionError(
  error: unknown,
  fallback: string,
): InventoryProposalActionState {
  return {
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : fallback,
    status: "error",
  };
}
