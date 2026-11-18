import { Badge, Box, Button, Flex, Grid, Heading, Image, Text } from "@chakra-ui/react";
import Link from "next/link";
import type { Route } from "next";
import { Suspense } from "react";
import {
  inventoryItemMediaContentPath,
  listInventoryClothingRecommendations,
  type InventoryClothingRecommendation,
} from "@/lib/quantself-api-client";
import { InventoryShellCard } from "../inventory-shell";
import * as inventoryActions from "../actions";
import {
  SpecialistInventoryLeadSkeleton,
  SpecialistInventoryPage,
  type SpecialistInventoryRequest,
} from "../specialist-inventory-page";
import { ClothingTimeZoneSync } from "./clothing-time-zone-sync";

type ClothingInventoryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

type ClothingInventoryRequest = SpecialistInventoryRequest & {
  actionState: ReturnType<typeof clothingActionState>;
  timeZone: string | null;
};

export default function ClothingInventoryPage({
  searchParams,
}: ClothingInventoryPageProps) {
  const request = Promise.resolve(searchParams).then((resolvedParams) => {
    const params = resolvedParams ?? {};
    const query = firstValue(params.q);
    const clothingState = firstValue(params.state);
    const timeZone = sanitizeTimeZone(firstValue(params.timeZone));
    const normalizedClothingState =
      clothingState === "clean" || clothingState === "dirty"
        ? clothingState
        : null;

    return {
      actionState: clothingActionState(params),
      clothingState: normalizedClothingState,
      query,
      returnFilters: {
        state: normalizedClothingState,
        timeZone,
      },
      timeZone,
    } satisfies ClothingInventoryRequest;
  });
  const recommendationsPromise = request.then(({ timeZone }) =>
    loadClothingRecommendations(timeZone),
  );

  return SpecialistInventoryPage({
    actionBanner: (resolvedRequest) => {
      const returnTo = buildClothingFilterHref(
        resolvedRequest.query,
        resolvedRequest.clothingState ?? null,
        resolvedRequest.timeZone,
      );

      return (
        <ClothingActionBanner
          actionState={resolvedRequest.actionState}
          returnTo={returnTo}
        />
      );
    },
    category: "clothing",
    emptyLabel: "clothing",
    filters: (resolvedRequest) => (
      <ClothingStateFilters request={resolvedRequest} />
    ),
    headerAction: (resolvedRequest) => {
      const returnTo = buildClothingFilterHref(
        resolvedRequest.query,
        resolvedRequest.clothingState ?? null,
        resolvedRequest.timeZone,
      );

      return (
        <form
          action={
            inventoryActions.completeInventoryClothingLaundryRedirectAction
          }
        >
          <input name="mode" type="hidden" value="all-dirty" />
          <input name="returnTo" type="hidden" value={returnTo} />
          <Button type="submit" variant="outline" size="xs">
            Laundry all dirty
          </Button>
        </form>
      );
    },
    lead: (
      <>
        <ClothingTimeZoneSync />
        <Suspense
          fallback={
            <SpecialistInventoryLeadSkeleton
              titles={["Wear today", "Upcoming events"]}
            />
          }
        >
          <ClothingRecommendations
            recommendationsPromise={recommendationsPromise}
            request={request}
          />
        </Suspense>
      </>
    ),
    path: "/inventory/clothing",
    request,
    title: "Clothing wardrobe",
  });
}

async function ClothingRecommendations({
  recommendationsPromise,
  request,
}: {
  recommendationsPromise: ReturnType<typeof loadClothingRecommendations>;
  request: Promise<ClothingInventoryRequest>;
}) {
  const [recommendations, resolvedRequest] = await Promise.all([
    recommendationsPromise,
    request,
  ]);
  const returnTo = buildClothingFilterHref(
    resolvedRequest.query,
    resolvedRequest.clothingState ?? null,
    resolvedRequest.timeZone,
  );

  return (
    <>
      <WearTodayCard
        recommendation={recommendations.wearToday}
        returnTo={returnTo}
      />
      <UpcomingEventsCard
        recommendations={recommendations.upcomingEvents}
        returnTo={returnTo}
        timeZone={resolvedRequest.timeZone ?? "UTC"}
      />
    </>
  );
}

function ClothingStateFilters({
  request,
}: {
  request: ClothingInventoryRequest;
}) {
  return (
    <Flex aria-label="Clothing state" as="nav" wrap="wrap" gap="2">
      {[
        {
          href: buildClothingFilterHref(request.query, null, request.timeZone),
          label: "All",
          value: null,
        },
        {
          href: buildClothingFilterHref(
            request.query,
            "clean",
            request.timeZone,
          ),
          label: "Clean",
          value: "clean" as const,
        },
        {
          href: buildClothingFilterHref(
            request.query,
            "dirty",
            request.timeZone,
          ),
          label: "Dirty",
          value: "dirty" as const,
        },
      ].map((filter) => {
        const active = request.clothingState === filter.value;
        return (
          <Button key={filter.label} asChild size="sm" variant={active ? "solid" : "outline"}>
            <Link aria-current={active ? "page" : undefined} href={filter.href}>
              {filter.label}
            </Link>
          </Button>
        );
      })}
    </Flex>
  );
}

function ClothingActionBanner({
  actionState,
  returnTo,
}: {
  actionState: {
    confirmationId: string | null;
    message: string;
    itemId: string | null;
    type:
      | "error"
      | "laundry-completed"
      | "none"
      | "recommendation-declined"
      | "wear-recorded"
      | "wear-undone";
  };
  returnTo: string;
}) {
  if (actionState.type === "none") {
    return null;
  }

  const failed = actionState.type === "error";

  return (
    <Grid gap="3" rounded="xl" borderWidth="1px" p="3" textStyle="sm"
      bg={failed ? "bg.error" : "bg.subtle"}
      borderColor={failed ? "border.error" : undefined}
    >
      <Text role={failed ? "alert" : "status"} color={failed ? "fg.error" : undefined}>
        {actionState.message}
      </Text>
      {actionState.type === "wear-recorded" && actionState.confirmationId ? (
        <Flex asChild justify="start">
          <form
            action={
              inventoryActions.undoInventoryClothingWearConfirmationRedirectAction
            }
          >
            <input
              name="confirmationId"
              type="hidden"
              value={actionState.confirmationId}
            />
            <input name="itemId" type="hidden" value={actionState.itemId ?? ""} />
            <input name="returnTo" type="hidden" value={returnTo} />
            <Button type="submit" variant="outline">
              Undo last wear
            </Button>
          </form>
        </Flex>
      ) : null}
    </Grid>
  );
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function clothingActionState(
  params: Record<string, string | string[] | undefined>,
): {
  confirmationId: string | null;
  message: string;
  itemId: string | null;
  type:
    | "error"
    | "laundry-completed"
    | "none"
    | "recommendation-declined"
    | "wear-recorded"
    | "wear-undone";
} {
  const type = firstValue(params.clothingAction);

  if (!type) {
    return {
      confirmationId: null,
      message: "",
      itemId: null,
      type: "none",
    };
  }

  return {
    confirmationId: firstValue(params.confirmationId) || null,
    message: firstValue(params.message) || clothingActionMessage(type),
    itemId: firstValue(params.itemId) || null,
    type:
      type === "wear-recorded" ||
      type === "wear-undone" ||
      type === "laundry-completed" ||
      type === "recommendation-declined" ||
      type === "error"
        ? type
        : "none",
  };
}

function clothingActionMessage(type: string): string {
  switch (type) {
    case "wear-recorded":
      return "Wear recorded. Undo is available now.";
    case "wear-undone":
      return "Wear undone. Clothing Item restored to clean.";
    case "laundry-completed":
      return "Laundry completed.";
    case "recommendation-declined":
      return "Recommendation declined.";
    case "error":
      return "Clothing action failed.";
    default:
      return "";
  }
}

function buildClothingFilterHref(
  query: string,
  state: "clean" | "dirty" | null,
  timeZone: string | null = null,
): Route {
  const params = new URLSearchParams();

  if (query) {
    params.set("q", query);
  }

  if (state) {
    params.set("state", state);
  }

  if (timeZone) {
    params.set("timeZone", timeZone);
  }

  return `/inventory/clothing${params.size > 0 ? `?${params}` : ""}` as Route;
}

async function loadClothingRecommendations(timeZone: string | null): Promise<{
  upcomingEvents: InventoryClothingRecommendation[];
  wearToday: InventoryClothingRecommendation | null;
}> {
  const recommendations = await listInventoryClothingRecommendations(
    timeZone ? { timeZone } : undefined,
  );

  return {
    upcomingEvents: recommendations
      .filter(
        (recommendation) =>
          recommendation.kind === "EVENT" && recommendation.event !== null,
      )
      .sort(
        (left, right) =>
          new Date(left.event!.startsAt).getTime() -
          new Date(right.event!.startsAt).getTime(),
      ),
    wearToday:
      recommendations.find(
        (recommendation) => recommendation.kind === "DAILY",
      ) ?? null,
  };
}

function UpcomingEventsCard({
  recommendations,
  returnTo,
  timeZone,
}: {
  recommendations: InventoryClothingRecommendation[];
  returnTo: string;
  timeZone: string;
}) {
  return (
    <InventoryShellCard title="Upcoming events">
      {recommendations.length > 0 ? (
        <Grid gap="4">
          {recommendations.map((recommendation) => (
            <Grid
              as="section" gap="3" rounded="xl" borderWidth="1px" p="3"
              key={recommendation.id}
            >
              <Grid gap="1">
                <Heading as="h3" size="sm" fontWeight="medium">
                  {recommendation.event?.label ?? "Upcoming event"}
                </Heading>
                {recommendation.event ? (
                  <Text color="fg.muted" textStyle="sm">
                    {formatEventStart(recommendation.event.startsAt, timeZone)}
                  </Text>
                ) : null}
              </Grid>
              <RecommendationDecision
                recommendation={recommendation}
                returnTo={returnTo}
              />
            </Grid>
          ))}
        </Grid>
      ) : (
        <Text color="fg.muted" textStyle="sm">
          No upcoming event outfits published.
        </Text>
      )}
    </InventoryShellCard>
  );
}

function WearTodayCard({
  recommendation,
  returnTo,
}: {
  recommendation: InventoryClothingRecommendation | null;
  returnTo: string;
}) {
  return (
    <InventoryShellCard title="Wear today">
      {recommendation ? (
        <RecommendationDecision
          recommendation={recommendation}
          returnTo={returnTo}
        />
      ) : (
        <Text color="fg.muted" textStyle="sm">
          No outfit published today.
        </Text>
      )}
    </InventoryShellCard>
  );
}

function RecommendationDecision({
  recommendation,
  returnTo,
}: {
  recommendation: InventoryClothingRecommendation;
  returnTo: string;
}) {
  return (
    <Grid gap="4">
      <Text textStyle="sm">{recommendation.reason}</Text>
      {recommendation.options.map((option) => (
        <Grid as="section" gap="2" key={option.id}>
          <Flex align="center" gap="2">
            <Heading as="h3" size="sm" fontWeight="medium">
              {option.slot === "PRIMARY" ? "Primary" : "Alternative"}
            </Heading>
            {option.slot === "ALTERNATIVE" ? (
              <Badge variant="outline">Optional</Badge>
            ) : null}
          </Flex>
          {option.reason ? (
            <Text color="fg.muted" textStyle="sm">{option.reason}</Text>
          ) : null}
          <Grid as="ul" gap="2" listStyleType="none">
            {option.items.map((item) => (
              <Grid
                as="li" templateColumns="auto minmax(0, 1fr)" gap="3" rounded="lg" borderWidth="1px" px="3" py="2"
                key={item.id}
              >
                {item.imageId ? (
                  <Image
                    alt={item.title}
                    mt="0.5" boxSize="16" rounded="md" borderWidth="1px" objectFit="cover"
                    src={inventoryItemMediaContentPath(item.id, item.imageId)}
                  />
                ) : (
                  <Box mt="0.5" boxSize="16" rounded="md" borderWidth="1px" borderStyle="dashed" bg="bg.subtle" />
                )}
                <Box minW="0">
                  <Flex wrap="wrap" align="center" gap="2">
                    <Text as="span" fontWeight="medium" textStyle="sm">{item.title}</Text>
                    {item.availability === "UNAVAILABLE" ? (
                      <Badge variant="outline">Unavailable</Badge>
                    ) : null}
                    {item.archiveState === "ARCHIVED" ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : null}
                    {item.archiveState === "DELETED" ? (
                      <Badge variant="outline">Deleted</Badge>
                    ) : null}
                    {item.clothingState === "dirty" ? (
                      <Badge variant="outline">Dirty</Badge>
                    ) : null}
                  </Flex>
                  <Text mt="1" color="fg.muted" textStyle="sm">
                    {item.where}
                  </Text>
                </Box>
              </Grid>
            ))}
          </Grid>
          <Flex asChild justify="start">
            <form
              action={
                inventoryActions.markInventoryClothingRecommendationWornRedirectAction
              }
            >
              <input
                name="recommendationId"
                type="hidden"
                value={recommendation.id}
              />
              <input name="optionId" type="hidden" value={option.id} />
              <input name="returnTo" type="hidden" value={returnTo} />
              <Button
                disabled={option.items.some(
                  (item) => item.availability !== "AVAILABLE",
                )}
                type="submit"
                variant={option.slot === "PRIMARY" ? "solid" : "outline"}
              >
                {option.slot === "PRIMARY"
                  ? "Wear this outfit"
                  : "Wear alternative"}
              </Button>
            </form>
          </Flex>
        </Grid>
      ))}
      <Flex asChild justify="start">
        <form
          action={
            inventoryActions.declineInventoryClothingRecommendationRedirectAction
          }
        >
          <input
            name="recommendationId"
            type="hidden"
            value={recommendation.id}
          />
          <input name="returnTo" type="hidden" value={returnTo} />
          <Button type="submit" variant="outline">
            Decline recommendation
          </Button>
        </form>
      </Flex>
    </Grid>
  );
}

function formatEventStart(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
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
