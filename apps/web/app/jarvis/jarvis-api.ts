import createClient from "openapi-fetch";
import type { components, paths } from "@/lib/generated/quantself-api-schema";

// Created per call so the current global fetch is used.
const client = () =>
  createClient<paths>({ baseUrl: window.location.origin, credentials: "same-origin" });

export type ConversationSummary = {
  id: string; channel: "app" | "phone"; capturedAt: string; summary: string | null;
  preview: string; turnCount: number; hasAudio: boolean;
};
export type ConversationDetail = {
  id: string; channel: "app" | "phone"; capturedAt: string; summary: string | null;
  hasAudio: boolean; turns: { role: "user" | "assistant"; text: string }[];
};
export type { components };

export async function listConversations(cursor?: string | null) {
  const { data, error } = await client().GET("/api/v1/jarvis/conversations", {
    params: { query: { limit: 25, ...(cursor ? { cursor } : {}) } },
    cache: "no-store",
  });
  if (!data) throw new Error(error?.message ?? "Conversations unavailable.");
  return data as { conversations: ConversationSummary[]; nextCursor: string | null };
}

export async function readConversation(id: string) {
  const { data, error, response } = await client().GET("/api/v1/jarvis/conversations/{id}", {
    params: { path: { id } },
    cache: "no-store",
  });
  if (!data) throw new Error(response?.status === 404 ? "Conversation not found." : (error?.message ?? "Conversation unavailable."));
  return data as ConversationDetail;
}

export async function deleteConversation(id: string) {
  const { error, response } = await client().DELETE("/api/v1/todo-captures/{id}", {
    params: { path: { id } },
  });
  if (!response.ok) throw new Error(error?.message ?? "Delete failed.");
}

export const audioSrc = (id: string) => `/api/v1/todo-captures/${encodeURIComponent(id)}/audio`;
