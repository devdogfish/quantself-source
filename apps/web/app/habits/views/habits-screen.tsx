"use client";
// Page frame for the redesigned Habits pages (#176): one PageHeader (title, description, quick stats, section nav) + the view.
import { Badge, Box, Button, HStack, Text } from "@chakra-ui/react";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { AreaNav } from "@/components/shared/area-nav";
import { asRoute } from "@/components/shared/dashboard-types";
import { PageBody, PageHeader } from "@/components/shared/page-layout";
import { useHabitsData } from "./habits-data";
import { habitNavItems, habitSections, type HabitSectionId } from "./habits-nav";
import { AllHabitsView } from "./habits-table";
import { automaticity, counts, fmt, lifetimeReps, recent, recovery, type State } from "./habit-metrics";
import { SummaryView } from "./summary-view";
import { AskView, HabitView, RoutineView, type Ctx } from "./views";

export type HabitsScreenView = Exclude<HabitSectionId, "system"> | "habit";

const copy: Record<Exclude<HabitsScreenView, "habit">, { title: string; desc: string }> = {
  today: { title: "Today", desc: "Do the next thing. Logging only." },
  all: { title: "Habits", desc: "Every habit in one table. Search, filter, open one for its details." },
  summary: { title: "Summary", desc: "Review the system: what it carries, where it breaks, and what needs a decision." },
  ask: { title: "Ask", desc: "Feeling off and a habit is due? Get a concrete next step." },
};
const routes: Record<string, string> = { routine: "/habits", today: "/habits", habits: "/habits/all", all: "/habits/all", summary: "/habits/summary", ask: "/habits/ask" };

export function HabitsScreen({ view, habitId }: { view: HabitsScreenView; habitId?: string }) {
  const router = useRouter();
  const data = useHabitsData();
  const { hist } = data;
  const ctx: Ctx = {
    hist, habitId: habitId ?? "", set: data.set,
    open: (id) => router.push(asRoute(`/habits/${id}`)),
    go: (v) => router.push(asRoute(routes[v] ?? "/habits")),
  };
  const nav = <AreaNav label="Habit sections" items={habitNavItems} currentPath={habitSections.find((s) => s.id === (view === "habit" ? "all" : view))?.href} />;
  const sample = data.stub ? <Badge variant="outline" size="sm" fontWeight="medium">Sample data</Badge> : null;
  const today = Object.values(hist).filter((h) => h.at(-1) !== "none");
  const summaryCounts = view === "summary" && data.summary && !Object.keys(hist).length ? data.summary : null;
  const logged = summaryCounts?.logged ?? today.filter((h) => counts(h.at(-1)! as State)).length;

  if (data.loading || data.error) return (
    <Box pb="24">
      <PageHeader title={view === "habit" ? "Habits" : copy[view].title} nav={nav} description={data.error ?? "Loading habits…"}
        actions={data.error ? <Button size="xs" variant="outline" onClick={data.retry}>Retry</Button> : undefined} />
    </Box>
  );

  if (view === "habit") {
    const h = data.habits.find((x) => x.id === habitId && hist[x.id]);
    if (!h) return (
      <Box pb="24">
        <PageHeader title="Habit not found" description="This habit is not tracked, or the link is out of date." nav={nav}
          actions={<Button size="xs" variant="outline" onClick={() => router.push(asRoute("/habits/all"))}><ArrowLeft />All habits</Button>} />
      </Box>
    );
    const hs = hist[h.id]!, fact = data.facts[h.id], votes = fact?.reps ?? hs.filter(counts).length, all = fact ?? recent(hs, hs.length), rec = fact?.recovery ?? recovery(hs), auto = automaticity(votes);
    return (
      <Box pb="24">
        <PageHeader
          title={<HStack gap="3">{h.name}{sample}</HStack>}
          description={h.identity}
          facts={[
            { label: "Votes since " + h.started, value: votes },
            { label: "Rate, since start", value: `${all.eligible ? Math.round((all.reps / all.eligible) * 100) : 0}%` },
            { label: "Automatic (est.)", value: `${Math.round(auto * 100)}%` },
            { label: "Back after a miss", value: `${rec.recovered} of ${rec.misses}` },
          ]}
          actions={<Button size="xs" variant="outline" onClick={() => router.push(asRoute("/habits/all"))}><ArrowLeft />All habits</Button>}
          nav={nav}
        />
        <PageBody><HabitView key={h.id} ctx={ctx} /></PageBody>
      </Box>
    );
  }

  return (
    <Box pb="24">
      <PageHeader
        title={<HStack gap="3">{copy[view].title}{sample}</HStack>}
        description={copy[view].desc}
        actions={<Text textStyle="xs" color="fg.muted" fontVariantNumeric="tabular-nums">{fmt(data.today, { weekday: "short", month: "short", day: "numeric" })} · {logged} of {summaryCounts?.due ?? today.length} logged</Text>}
        nav={nav}
      />
      <PageBody>
        {view === "today" && <RoutineView ctx={ctx} />}
        {view === "all" && <AllHabitsView ctx={ctx} />}
        {view === "summary" && <SummaryView ctx={ctx} />}
        {view === "ask" && <AskView ctx={ctx} />}
      </PageBody>
    </Box>
  );
}
