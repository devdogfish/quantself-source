"use client";
import { useHabitsData } from "./habits-data";
// All habits (#176): one flat table in the reference crawl-table style. One line per row, no charts.
import { useMemo, useState } from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { DataToolbar, copyExportText, downloadText } from "@/components/shared/data-toolbar";
import { FilterSelect } from "@/components/shared/filter-select";
import { TablePagination } from "@/components/shared/table-pagination";
import { habitRows, filterHabitRows, exportHabitRows } from "./habits-table-data";
import type { Ctx } from "./views";
import { ConsistencyRating } from "./parts";

const PAGE = 12;
const statusDot = { testing: "orange.solid", building: "brand.solid", established: "green.solid", paused: "fg.subtle", pending: "fg.subtle" } as const;
export function AllHabitsView({ ctx }: { ctx: Ctx }) {
  const { habits, stacks, dates, facts } = useHabitsData();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "tracked" | "untracked">("all");
  const [stack, setStack] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("stack");
  const [page, setPage] = useState(1);

  const all = useMemo(() => habitRows(habits, stacks, ctx.hist, dates, facts), [habits, stacks, ctx.hist, dates, facts]);
  const rows = useMemo(() => filterHabitRows(all, stacks, { query, scope, stack, status, sort }), [all, stacks, query, scope, stack, status, sort]);
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const cols = "minmax(220px,2fr) 150px 130px 100px 150px 100px";

  return (
    <DataPanel>
      <DataToolbar query={query} onQuery={reset(setQuery)} placeholder="Search habits"
        segments={[{ value: "all", label: "All" }, { value: "tracked", label: "Tracked" }, { value: "untracked", label: "Not tracked" }]}
        value={scope} onValue={reset(setScope)} count={`${rows.length} habits`}
        copyLabel="Copy table" onCopy={() => copyExportText(async () => exportHabitRows(rows, "\t"))}
        downloadLabel="Download CSV" onDownload={() => downloadText(exportHabitRows(rows, ","), "habits.csv", "text/csv")} />
      <Flex gap="2" px="4" py="2.5" borderBottomWidth="1px" wrap="wrap" align="center">
        <FilterSelect label="Stack" w="44" value={stack} onChange={reset(setStack)} items={[{ value: "all", label: "All stacks" }, ...stacks.map((s) => ({ value: s.id, label: s.name }))]} />
        <FilterSelect label="Status" w="40" value={status} onChange={reset(setStatus)} items={[{ value: "all", label: "Any status" }, ...["Testing", "Building", "Established", "Not started", ...(habits.some(h => h.status === "paused") ? ["Paused"] : []), "Breaking"].map((s) => ({ value: s, label: s }))]} />
        <HStack gap="2" ms="auto"><Text textStyle="xs" color="fg.muted">Sort</Text>
          <FilterSelect label="Sort" w="44" highlightActive={false} value={sort} onChange={reset(setSort)} items={[{ value: "stack", label: "Stack order" }, { value: "name", label: "Name" }, { value: "rate", label: "Lowest consistency" }, { value: "recent", label: "Last done" }]} />
        </HStack>
      </Flex>
      <DataGrid label="All habits" columns={cols} minW="900px" empty="No habits match these filters."
        headers={[{ label: "Habit" }, { label: "Stack" }, { label: "Status" }, { label: "Started" }, { label: "Consistency" }, { label: "Last done", align: "right" }]}>
        {shown.map((r) => {
          const tracked = r.tracked;
          const cells = [
            <Text key="n" truncate fontWeight="medium">{r.h.name}</Text>,
            <Text key="s" truncate color="fg.muted">{r.stack}</Text>,
            <HStack key="st" gap="1.5"><Box boxSize="1.5" rounded="full" bg={r.h.kind === "break" ? "fg.subtle" : statusDot[r.h.status]} /><Text color="fg.muted">{r.status}</Text></HStack>,
            <Text key="d" color="fg.muted">{r.h.started}</Text>,
            <ConsistencyRating key="r" pct={r.rate} />,
            <Text key="l" textAlign="right" color="fg.muted">{r.last ?? "–"}</Text>,
          ];
          return tracked
            ? <DataGridRow key={r.h.id} columns={cols} href={`/habits/${r.h.id}`}>{cells}</DataGridRow>
            : <DataGridRow key={r.h.id} columns={cols}>{cells}</DataGridRow>;
        })}
      </DataGrid>
      <TablePagination count={rows.length} pageSize={PAGE} page={page} onPageChange={setPage} />
    </DataPanel>
  );
}
