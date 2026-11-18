import { Suspense } from "react";
import {
  listInventoryItems,
  listRemedyIntakes,
  type RemedyIntakeProjection,
} from "@/lib/quantself-api-client";
import {
  SpecialistInventoryLeadSkeleton,
  SpecialistInventoryPage,
  type SpecialistInventoryRequest,
} from "../specialist-inventory-page";
import { RemedyIntakePanel, type RemedyIntakeRange } from "./remedy-intake-panel";

type RemediesInventoryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

type RemediesInventoryRequest = SpecialistInventoryRequest & {
  range: RemedyIntakeRange;
  timeZone: string | null;
};

export default function RemediesInventoryPage({
  searchParams,
}: RemediesInventoryPageProps) {
  const request = Promise.resolve(searchParams).then((resolvedParams) => {
    const params = resolvedParams ?? {};
    const range = sanitizeRange(firstValue(params.range));
    const timeZone = sanitizeTimeZone(firstValue(params.timeZone));

    return {
      query: firstValue(params.q),
      range,
      returnFilters: { range, timeZone },
      timeZone,
    } satisfies RemediesInventoryRequest;
  });
  const remedyCatalogPromise = request.then(() =>
    listInventoryItems({ category: "homeopathy", clothingState: null, query: "" }),
  );
  const leadDataPromise = request.then(async (resolvedRequest) => ({
    intakes: await loadRemedyIntakes(resolvedRequest.range, resolvedRequest.timeZone ?? "UTC"),
    remedies: await remedyCatalogPromise,
  }));

  return SpecialistInventoryPage({
    category: "homeopathy",
    emptyLabel: "remedy",
    lead: (
      <Suspense
        fallback={
          <SpecialistInventoryLeadSkeleton titles={["Remedy timeline"]} />
        }
      >
        <RemedyInventoryLead dataPromise={leadDataPromise} request={request} />
      </Suspense>
    ),
    path: "/inventory/remedies",
    request,
    title: "Owned remedies",
  });
}

async function RemedyInventoryLead({
  dataPromise,
  request,
}: {
  dataPromise: Promise<{
    intakes: RemedyIntakeProjection[];
    remedies: Awaited<ReturnType<typeof listInventoryItems>>;
  }>;
  request: Promise<RemediesInventoryRequest>;
}) {
  const [{ intakes, remedies }, resolvedRequest] = await Promise.all([
    dataPromise,
    request,
  ]);

  return (
    <RemedyIntakePanel
      initialIntakes={intakes}
      nowIso={new Date().toISOString()}
      range={resolvedRequest.range}
      remedies={remedies.filter((remedy) => remedy.remedyProfile)}
      searchQuery={resolvedRequest.query}
      timeZone={resolvedRequest.timeZone ?? undefined}
    />
  );
}

async function loadRemedyIntakes(
  range: RemedyIntakeRange,
  timeZone: string,
): Promise<RemedyIntakeProjection[]> {
  const intakes: RemedyIntakeProjection[] = [];
  let cursor: string | null = null;

  do {
    const result = await listRemedyIntakes({ cursor, range, timeZone });
    intakes.push(...result.intakes);
    cursor = result.pageInfo.nextCursor;
  } while (cursor);

  return intakes;
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function sanitizeRange(value: string): RemedyIntakeRange {
  switch (value) {
    case "7d":
    case "30d":
    case "90d":
    case "all":
      return value;
    default:
      return "30d";
  }
}

function sanitizeTimeZone(value: string): string | null {
  if (!value) {
    return null;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
