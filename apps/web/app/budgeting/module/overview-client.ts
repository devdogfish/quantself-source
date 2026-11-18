import createClient from "openapi-fetch";
import type { operations, paths } from "@/lib/generated/quantself-api-schema";
export type ModuleOverview = operations["getBudgetModuleOverview"]["responses"][200]["content"]["application/json"];
export async function fetchModuleOverview(query: { mode: "week" | "month"; offset: number; context: "yes" | "no"; contextDate?: string; session?: string; ruleIds?: string }, signal?: AbortSignal): Promise<ModuleOverview> {
  const client = createClient<paths>({ baseUrl: window.location.origin, fetch: request => fetch(request) });
  const { data, error, response } = await client.GET("/api/v1/budgeting/module/overview", { params: { query }, signal, cache: "no-store" });
  if (!data) throw Error(error?.message ?? `Budget request failed (${response.status}).`);
  return data;
}
