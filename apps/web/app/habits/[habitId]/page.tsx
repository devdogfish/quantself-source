import { HabitsScreen } from "../views/habits-screen";

export default async function HabitPage({ params }: { params: Promise<{ habitId: string }> }) {
  const { habitId } = await params;
  return <HabitsScreen view="habit" habitId={habitId} />;
}
