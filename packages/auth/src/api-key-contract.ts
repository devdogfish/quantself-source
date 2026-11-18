import type { AgentClient } from "./agent-client";

export const API_KEY_PERMISSION_GROUPS = [
  {
    actions: ["read", "write", "import-tailored", "revise", "execute", "schedule-interview"],
    description: "Use import-tailored for draft batches. All Jobs actions require explicit custom grants.",
    domain: "jobs",
    label: "Jobs",
  },
  { actions: ["read", "write", "delete"], description: "Manage private budgeting records through explicit custom grants.", domain: "budgeting", label: "Budgeting" },
  {
    actions: ["read", "write", "delete"],
    description: "Read and correct habit observations. Requires explicit custom grants.",
    domain: "habits",
    label: "Habits",
  },
  {
    actions: ["read", "write", "approve", "delete"],
    description: "Read to-dos, edit task data, approve execution, or permanently delete captures independently. Requires explicit custom grants.",
    domain: "todos",
    label: "To-Do",
  },
  {
    actions: ["book", "read", "write"],
    description: "Book: read open slots and book or cancel visitor meetings (the portfolio's booking-only key). Read and write: see booked meetings, cancel them and change booking hours. Requires explicit custom grants.",
    domain: "meetings",
    label: "Meetings",
  },
  {
    actions: ["create"],
    description: "Create a personal Appointment or To-Do through the configured Personal Assistant client.",
    domain: "personal-assistant",
    label: "Personal Assistant",
  },
  {
    actions: ["read", "write", "delete"],
    description: "Read and change health source records through the public API.",
    domain: "health",
    label: "Health",
  },
  {
    actions: ["read", "write", "delete"],
    description: "Read and change inventory records through the public API.",
    domain: "inventory",
    label: "Inventory",
  },
  {
    actions: ["read", "write", "delete"],
    description: "Read and change note records through the public API.",
    domain: "notes",
    label: "Notes",
  },
] as const;

export type ApiKeyPreset = "custom" | "editor" | "maintainer" | "reader";

export type ApiKeyStatus =
  | "active"
  | "disabled"
  | "expired"
  | "revoked"
  | "rotating";

export type ApiKeySummary = {
  agentClient?: AgentClient;
  createdAt: Date;
  expiresAt: Date | null;
  id: string;
  lastRequestAt: Date | null;
  maskedKey: string;
  name: string;
  preset: ApiKeyPreset;
  replacementCredentialId: string | null;
  revokedAt: Date | null;
  rotatedFromCredentialId: string | null;
  rotationOverlapEndsAt: Date | null;
  permissions: string[];
  status: ApiKeyStatus;
};
