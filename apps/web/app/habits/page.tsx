import { Habits } from "./habits";
import { prototypeVariant } from "./habits-prototype-variant";
import { HabitsScreen } from "./views/habits-screen";

export default async function HabitsPage({ searchParams }: PageProps<"/habits">) {
  const query = await searchParams;
  const section = query.section === "system" || query.section === "playbook" ? query.section : "today";
  const variant = prototypeVariant(query.variant);
  if (variant) {
    return <Habits key={JSON.stringify([query.date, query.stack])} variant={variant} prototypeSection={section} />;
  }
  return <HabitsScreen view="today" />;
}
