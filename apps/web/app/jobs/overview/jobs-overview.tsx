"use client";

// Jobs Overview: who has the next move (Buildkite queue split), Stripe-style metric tiles, one pipeline bar,
// a Ramp-style table of how often the agent's verdict matched the Owner's decision, and weekly throughput.
import Link from "next/link";
import { Box, Flex, Grid, HStack, Stack, Table, Text } from "@chakra-ui/react";
import { ArrowRightIcon } from "lucide-react";
import { asRoute } from "@/components/shared/dashboard-types";
import { jobsClient, type Overview } from "../jobs-client";
import { JobsFrame, LoadState, ago, useJobsData, verdictMeta } from "../jobs-frame";

const runnerDot = { idle: "green.500", submitting: "orange.400", paused: "gray.400", offline: "red.500" } as const;
const runnerLabel = { idle: "Idle", submitting: "Submitting", paused: "Paused", offline: "Offline" } as const;
const percent = (n: number) => `${Math.round(n * 100)}%`;

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <Box h="6" />;
  const max = Math.max(...values), min = Math.min(...values);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - min) / (max - min || 1)) * 20}`).join(" ");
  return (
    <Box asChild color="colorPalette.solid" w="full" h="6">
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </Box>
  );
}

export function JobsOverview() {
  const { data, error, reload } = useJobsData((signal) => jobsClient.overview(signal), "overview");
  return <JobsFrame>{data ? <OverviewBody data={data} /> : <LoadState error={error} onRetry={reload} label="Loading overview…" />}</JobsFrame>;
}

function OverviewBody({ data }: { data: Overview }) {
  const lead = [
    { label: "Waiting on you", value: String(data.waitingOnYou), href: "/jobs/applications?tab=review", dot: "blue.500" },
    { label: "Waiting on runner", value: String(data.waitingOnRunner), href: "/jobs/submissions", dot: "orange.400" },
    { label: "Runner", value: `${runnerLabel[data.runner.state]}${data.runner.lastHeartbeatAt ? `, heartbeat ${ago(data.runner.lastHeartbeatAt)}` : ""}`,
      href: "/jobs/submissions", dot: runnerDot[data.runner.state] },
  ];
  const tiles = [
    { label: "Applied, 30 days", value: String(data.metrics.applied), series: data.weekly.map((w) => w.applied) },
    { label: "Approval rate", value: percent(data.metrics.approvalRate), series: data.weekly.map((w) => w.applied / Math.max(1, w.drafted)) },
    { label: "Response rate", value: percent(data.metrics.responseRate), series: [] },
    { label: "Median time to apply", value: data.metrics.medianDaysToApply === null ? "—" : `${data.metrics.medianDaysToApply} d`, series: [] },
  ];
  const pipeline = [
    { label: "Drafted", value: data.pipeline.drafted, color: "gray.300" },
    { label: "Reviewed", value: data.pipeline.reviewed, color: "blue.300" },
    { label: "Approved", value: data.pipeline.approved, color: "blue.500" },
    { label: "Applied", value: data.pipeline.applied, color: "green.500" },
  ];
  const maxWeek = Math.max(1, ...data.weekly.map((w) => w.drafted));
  return (
    <Stack maxW="7xl" mx="auto" px={{ base: "4", md: "6" }} py="6" gap="6">
      <Grid templateColumns={{ base: "1fr", md: "1fr 1fr 2fr" }} borderWidth="1px" rounded="l2" overflow="hidden">
        {lead.map((f, i) => (
          <Box key={f.label} asChild px="4" py="3" borderLeftWidth={{ md: i ? "1px" : 0 }} borderTopWidth={{ base: i ? "1px" : 0, md: 0 }} _hover={{ bg: "bg.subtle" }}>
            <Link href={asRoute(f.href)}>
              <HStack justify="space-between" gap="3">
                <Stack gap="0.5" minW="0">
                  <Text textStyle="xs" color="fg.muted" fontWeight="medium">{f.label}</Text>
                  <HStack gap="2" minW="0">
                    <Box boxSize="2" rounded="full" bg={f.dot} flexShrink={0} />
                    <Text textStyle={i < 2 ? "xl" : "sm"} fontWeight="semibold" fontVariantNumeric="tabular-nums" truncate>{f.value}</Text>
                  </HStack>
                </Stack>
                <Box color="fg.subtle" flexShrink={0}><ArrowRightIcon size={14} /></Box>
              </HStack>
            </Link>
          </Box>
        ))}
      </Grid>

      <Grid templateColumns={{ base: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }} borderWidth="1px" rounded="l2" overflow="hidden">
        {tiles.map((t, i) => (
          <Stack key={t.label} gap="1" p="4" borderLeftWidth={{ lg: i ? "1px" : 0 }} borderTopWidth={{ base: i > 1 ? "1px" : 0, lg: 0 }}>
            <Text textStyle="xs" color="fg.muted" fontWeight="medium">{t.label}</Text>
            <Text textStyle="2xl" fontWeight="semibold" fontVariantNumeric="tabular-nums">{t.value}</Text>
            <Sparkline values={t.series} />
          </Stack>
        ))}
      </Grid>

      <Box borderWidth="1px" rounded="l2" p="5">
        <HStack justify="space-between" mb="3">
          <Text textStyle="sm" fontWeight="semibold">Pipeline</Text>
          <Text textStyle="xs" color="fg.muted">{percent(data.pipeline.applied / Math.max(1, data.pipeline.drafted))} of drafts applied</Text>
        </HStack>
        <Flex h="3" rounded="full" overflow="hidden" gap="0.5" bg="bg.muted">
          {pipeline.map((s, i) => <Box key={s.label} flex={Math.max(0, s.value - (pipeline[i + 1]?.value ?? 0))} bg={s.color} title={`${s.label}: ${s.value}`} />)}
        </Flex>
        <Grid templateColumns="repeat(4, 1fr)" gap="3" mt="3">
          {pipeline.map((s, i) => (
            <Stack key={s.label} gap="0">
              <HStack gap="1.5" textStyle="xs" color="fg.muted"><Box boxSize="2" rounded="xs" bg={s.color} />{s.label}</HStack>
              <HStack gap="1.5" align="baseline">
                <Text textStyle="sm" fontWeight="semibold" fontVariantNumeric="tabular-nums">{s.value}</Text>
                {i > 0 && <Text textStyle="xs" color="fg.muted">{percent(s.value / Math.max(1, pipeline[i - 1].value))}</Text>}
              </HStack>
            </Stack>
          ))}
        </Grid>
      </Box>

      <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 3fr) minmax(0, 2fr)" }} gap="6">
        <Box borderWidth="1px" rounded="l2" overflow="hidden">
          <Text textStyle="sm" fontWeight="semibold" px="5" pt="4" pb="3">Agent verdict vs your decision</Text>
          <Table.Root size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader ps="5">Agent said</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Drafts</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">You approved</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Skipped</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end" pe="5">Rejected</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body fontVariantNumeric="tabular-nums">
              {data.alignment.map((r) => {
                const share = (n: number) => percent(n / Math.max(1, r.drafts));
                return (
                  <Table.Row key={r.verdict}>
                    <Table.Cell ps="5"><HStack gap="2"><Box boxSize="2" rounded="full" bg={verdictMeta[r.verdict].color} />{verdictMeta[r.verdict].label}</HStack></Table.Cell>
                    <Table.Cell textAlign="end" color="fg.muted">{r.drafts}</Table.Cell>
                    <Table.Cell textAlign="end">{share(r.approved)}</Table.Cell>
                    <Table.Cell textAlign="end">{share(r.skipped)}</Table.Cell>
                    <Table.Cell textAlign="end" pe="5">{share(r.rejected)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </Box>
        <Box borderWidth="1px" rounded="l2" p="5">
          <HStack justify="space-between" mb="5">
            <Text textStyle="sm" fontWeight="semibold">Weekly throughput</Text>
            <HStack gap="3" textStyle="xs" color="fg.muted">
              <HStack gap="1.5"><Box boxSize="2" rounded="xs" bg="colorPalette.muted" />Drafted</HStack>
              <HStack gap="1.5"><Box boxSize="2" rounded="xs" bg="colorPalette.solid" />Applied</HStack>
            </HStack>
          </HStack>
          <Flex gap="1.5" align="end" h="160px">
            {data.weekly.map((w) => (
              <Box key={w.week} flex="1" h="full" position="relative" title={`${w.week}: ${w.drafted} drafted, ${w.applied} applied`}>
                <Box position="absolute" bottom="0" insetX="0" h={`${(w.drafted / maxWeek) * 100}%`} bg="colorPalette.muted" rounded="xs" />
                <Box position="absolute" bottom="0" insetX="0" h={`${(w.applied / maxWeek) * 100}%`} bg="colorPalette.solid" rounded="xs" />
              </Box>
            ))}
          </Flex>
          <HStack justify="space-between" mt="2" textStyle="xs" color="fg.subtle"><Text>{data.weekly[0]?.week}</Text><Text>{data.weekly.at(-1)?.week}</Text></HStack>
        </Box>
      </Grid>
    </Stack>
  );
}
