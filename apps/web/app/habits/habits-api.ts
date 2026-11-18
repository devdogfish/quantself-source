import createClient from "openapi-fetch";
import type { paths } from "@/lib/generated/quantself-api-schema";
import { createHabitStore, HabitSaveError, type Command } from "./habit-store";
const client = createClient<paths>({
  baseUrl: typeof window === "undefined" ? "" : window.location.origin,
  credentials: "same-origin",
});
export async function readHabitDay(date?: string) {
  const { data, error } = await client.GET("/api/v1/habits/day", {
    params: { query: { date } },
    cache: "no-store",
  });
  if (!data) throw new Error(error?.message ?? "Habits unavailable.");
  return data;
}
export async function saveHabit(command: Command) {
  const { data, error, response } = await client.POST(
    "/api/v1/habits/commands",
    { body: command },
  );
  if (!data && response.status === 409) {
    const day = await readHabitDay(command.date);
    throw new HabitSaveError(error?.message ?? "Occurrence changed. Review and try again.", true,
      day.occurrences.find(r => r.habitId === command.habitId));
  }
  if (!data)
    throw new HabitSaveError(
      error?.message ?? "Save uncertain. Retry.",
      response.status < 500,
    );
  return data;
}

// Survives route navigation; pending commands and errors remain visible on return.
export const habitStore = createHabitStore(saveHabit);
export { client as habitClient };
