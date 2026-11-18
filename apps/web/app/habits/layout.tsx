import { HabitsDataProvider } from "./views/habits-data";

// Shared data for the Habits pages, so a check-in on Today shows on the Habit page without a refetch.
export default function HabitsLayout({ children }: { children: React.ReactNode }) {
  return <HabitsDataProvider>{children}</HabitsDataProvider>;
}
