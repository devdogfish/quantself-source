export const habitSections = [
  { id: "today", label: "Today", href: "/habits" },
  { id: "all", label: "Habits", href: "/habits/all" },
  { id: "summary", label: "Summary", href: "/habits/summary" },
  { id: "ask", label: "Ask", href: "/habits/ask" },
  { id: "system", label: "System", href: "/habits/system" },
] as const;
export type HabitSectionId = (typeof habitSections)[number]["id"];
export const habitNavItems = habitSections.map(({ label, href }) => ({ label, href, exact: true }));
