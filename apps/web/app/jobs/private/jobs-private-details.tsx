"use client";

import { Box, Button, Checkbox, Field, HStack, Input, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { SplitIcon } from "lucide-react";
import { canonicalQuestionTarget, referralNameField, parseCandidateContext, referralDeclined } from "../../../../../scripts/jobs/candidate-context";
import { candidateContextApi } from "../context/jobs-candidate-context-api";
import type { Track } from "../jobs-client";
import { JobsError, JobsLoading } from "../jobs-frame";
import { privateDetailsApi, privateFieldKey, type PrivateField } from "./private-api";
import { PrivateFieldRow } from "./private-field-row";
import { isPrivateField, privateFieldPresentation, reusableGroups, trackLabels } from "./private-fields";
import { createPrivateDetailsStore } from "./private-store";

const allTracks = Object.keys(trackLabels) as Track[];

/**
 * Reusable details, in two modes.
 * Without an application (Profile): shared answers as a settings list; a row can be overridden per résumé track.
 * With an application (Submissions, when the runner paused): only that application's questions plus shared answers
 * the runner asked for; each application answer can be saved for all applications instead.
 */
export function JobsPrivateDetails({ applicationId, onResumed }: { applicationId?: string; onResumed?: (ids: string[]) => void }) {
  const [resumedIds, setResumedIds] = useState<ReadonlySet<string>>(new Set());
  const resumed = useRef(onResumed);
  resumed.current = onResumed;
  const store = useMemo(() => createPrivateDetailsStore({
    list: (signal) => privateDetailsApi.list(applicationId, signal),
    save: (fields) => privateDetailsApi.save(fields, (ids) => {
      setResumedIds((current) => new Set([...current, ...ids]));
      resumed.current?.(ids);
    }),
  }), [applicationId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [details, setDetails] = useState<Awaited<ReturnType<typeof privateDetailsApi.application>>>();
  const { application: app, candidateRules, candidateRulesUnavailable } = details ?? {};
  const [contextEntries, setContextEntries] = useState<ReadonlyMap<string, string> | null>();
  const [overrides, setOverrides] = useState<ReadonlySet<string>>(new Set());
  const [shared, setShared] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [version, setVersion] = useState(0);
  const [questionsRefresh, setQuestionsRefresh] = useState<"idle" | "loading" | "failed">("idle");
  const fieldSignal = useRef<AbortSignal | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    fieldSignal.current = signal;
    void store.refresh(signal).then(
      () => { if (!signal.aborted) setPhase("ready"); },
      () => { if (!signal.aborted) setPhase("failed"); },
    );
    const refreshMetadata = () => { void store.refresh(signal).catch(() => {}); };
    window.addEventListener("focus", refreshMetadata);
    return () => { window.removeEventListener("focus", refreshMetadata); controller.abort(); };
  }, [store, version]);

  useEffect(() => {
    if (!applicationId) return;
    const controller = new AbortController();
    void privateDetailsApi.application(applicationId, controller.signal).then((details) => {
      if (!controller.signal.aborted) setDetails(details);
    }, () => {});
    return () => controller.abort();
  }, [applicationId]);

  const registeredListingFields = applicationId ? [...snapshot.fields.values()].filter((field) =>
    field.key !== "email" && field.scope.kind === "listing" && field.scope.applicationId === applicationId) : [];
  const hasReferralQuestion = registeredListingFields.some((field) => referralNameField(field.label, candidateRules));
  useEffect(() => {
    if (!hasReferralQuestion) return;
    let active = true;
    void candidateContextApi.get().then(({ markdown }) => {
      if (active) setContextEntries(parseCandidateContext(markdown));
    }, () => { if (active) setContextEntries(null); });
    return () => { active = false; };
  }, [hasReferralQuestion]);

  const resumedCount = applicationId ? Number(resumedIds.has(applicationId)) : resumedIds.size;
  const paused = !resumedCount && app?.status === "needs_attention" && app.issueCode === "manual_required";
  const requiredKeys = new Set(paused ? app?.privatePauseFieldKeys : undefined);
  const checkingReferral = hasReferralQuestion && contextEntries === undefined;
  const declinedReferral = contextEntries && referralDeclined(app, registeredListingFields, contextEntries, candidateRules);
  const contextQuestions = registeredListingFields.some(field => {
    const target = canonicalQuestionTarget(field.label, app);
    return target === "phone-device-type" || target === "phone-country-code";
  });
  const listingFields = app ? registeredListingFields.filter((field) =>
    !canonicalQuestionTarget(field.label, app) && (requiredKeys.has(field.key) || (isPrivateField(field, app, candidateRules) && !((checkingReferral || declinedReferral) && referralNameField(field.label, candidateRules))))) : [];
  const contextHref = "/jobs/profile";
  const commonKeys = new Set(reusableGroups.flatMap((group) => group.fields.map((field) => field.key)));
  // Profile: every reusable key once, at shared scope; track values show as overrides under it.
  const otherDefinitions = new Map<string, PrivateField>();
  for (const field of snapshot.fields.values()) {
    if (field.key === "email" || commonKeys.has(field.key) || field.scope.kind === "listing" || !isPrivateField(field)) continue;
    if (!otherDefinitions.has(field.key) || field.scope.kind === "global") otherDefinitions.set(field.key, { ...field, scope: { kind: "global" } });
  }
  const groups = [
    ...reusableGroups.map(({ title, fields }) => ({ title, fields: fields.map((field): PrivateField => ({ ...field, scope: { kind: "global" }, options: field.options ?? [] })) })),
    ...(otherDefinitions.size ? [{ title: "Other answers", fields: [...otherDefinitions.values()] }] : []),
  ];
  // Paused applications: shared answers the runner asked for.
  // Paused application questions that map onto a shared answer (e.g. Workday's "Legal First Name") are answered there.
  const canonicalKeys = new Set<string>(registeredListingFields.filter((field) => requiredKeys.has(field.key))
    .flatMap((field) => canonicalQuestionTarget(field.label, app) ?? []));
  const requiredShared = applicationId && paused
    ? groups.flatMap((group) => group.fields).filter((field) => requiredKeys.has(field.key) || canonicalKeys.has(field.key)) : [];
  const countSaved = (fields: PrivateField[]) => fields.filter((field) => snapshot.fields.get(privateFieldKey(field))?.hasValue).length;
  const fieldRows = (fields: PrivateField[], columns = false) => (
    <chakra.ul display={columns ? "grid" : undefined} gridTemplateColumns={columns ? { base: "1fr", md: "repeat(2, minmax(0, 1fr))" } : undefined}>
      {fields.map((definition) => {
      const key = privateFieldKey(definition);
      const current = snapshot.fields.get(key);
      return <PrivateFieldRow key={key} layout={applicationId ? "stacked" : "inline"} field={current ?? definition} current={current} status={snapshot.statuses.get(key)} store={store} presentation={privateFieldPresentation(current ?? definition, candidateRules)} />;
    })}
    </chakra.ul>
  );

  function refreshQuestions() {
    const signal = fieldSignal.current;
    if (signal?.aborted || questionsRefresh === "loading") return;
    setQuestionsRefresh("loading");
    void store.refresh(signal).then(
      () => { if (!signal?.aborted) setQuestionsRefresh("idle"); },
      () => { if (!signal?.aborted) setQuestionsRefresh("failed"); },
    );
  }

  const countGroup = (fields: PrivateField[]) => `${countSaved(fields)} of ${fields.length} saved`;
  const profileRow = (definition: PrivateField) => {
    const key = privateFieldKey(definition);
    const current = snapshot.fields.get(key);
    const shown = allTracks.filter((track) => overrides.has(`${track}:${definition.key}`) ||
      snapshot.fields.get(privateFieldKey({ key: definition.key, scope: { kind: "track", track } }))?.hasValue);
    const available = allTracks.filter((track) => !shown.includes(track));
    const menu = available.length > 0 && (
      <Menu.Root positioning={{ placement: "bottom-end" }}>
        <Menu.Trigger asChild>
          <Button type="button" size="xs" variant="ghost" aria-label={`Override ${definition.label} for a résumé track`}><SplitIcon /></Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content>
              {available.map((track) => (
                <Menu.Item key={track} value={track} onSelect={() => setOverrides((all) => new Set([...all, `${track}:${definition.key}`]))}>
                  Different for {trackLabels[track]}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    );
    return [
      <PrivateFieldRow key={key} layout="inline" field={current ?? definition} current={current} status={snapshot.statuses.get(key)} store={store}
        presentation={privateFieldPresentation(current ?? definition, candidateRules)} actions={menu} />,
      ...shown.map((track) => {
        const scoped: PrivateField = { ...definition, scope: { kind: "track", track } };
        const trackKey = privateFieldKey(scoped);
        const trackCurrent = snapshot.fields.get(trackKey);
        return <PrivateFieldRow key={trackKey} layout="inline" field={trackCurrent ?? scoped} current={trackCurrent} status={snapshot.statuses.get(trackKey)} store={store}
          presentation={{ label: `${trackLabels[track]} résumés` }} />;
      }),
    ];
  };
  const listingRow = (definition: PrivateField) => {
    const sharedHere = shared.has(definition.key);
    const field: PrivateField = sharedHere ? { ...definition, scope: { kind: "global" } } : definition;
    const key = privateFieldKey(field);
    const current = snapshot.fields.get(key);
    const toggle = (
      <Checkbox.Root size="xs" checked={sharedHere} onCheckedChange={(e) => {
        if (!store.keepDrafts()) return;
        setShared((all) => { const next = new Set(all); if (e.checked) next.add(definition.key); else next.delete(definition.key); return next; });
      }}>
        <Checkbox.HiddenInput />
        <Checkbox.Control />
        <Checkbox.Label textStyle="xs" color="fg.muted" whiteSpace="nowrap">All applications</Checkbox.Label>
      </Checkbox.Root>
    );
    return <PrivateFieldRow key={key} layout="stacked" field={current ?? field} current={current} status={snapshot.statuses.get(key)} store={store}
      presentation={privateFieldPresentation(current ?? definition, candidateRules)} actions={toggle} />;
  };

  return (
    <Stack gap="6">
      {candidateRulesUnavailable && <chakra.p role="status" css={{ fontSize: "sm", color: "fg.muted" }}>Configured question guidance is unavailable. You can still edit reusable details.</chakra.p>}
      {contextQuestions && (
        <chakra.p css={{ fontSize: "sm", color: "fg.muted" }}>
          Set phone device and calling code in{" "}
          <StyledLink href={contextHref} css={{ textDecoration: "underline", textUnderlineOffset: "4px" }}>
            Profile
          </StyledLink>
          , then reopen review and approve again.
        </chakra.p>
      )}
      {resumedCount > 0 && (
        <chakra.p role="status" css={{ fontSize: "sm" }}>
          {resumedCount === 1 ? "Application resumed." : `${resumedCount} applications resumed.`}
        </chakra.p>
      )}
      {phase === "loading" && <JobsLoading label="Loading saved-answer status…" />}
      {phase === "failed" && <JobsError message="Could not load saved-answer status." onRetry={() => { setPhase("loading"); setVersion((n) => n + 1); }} />}
      {phase === "ready" && (
        <>
          {applicationId && (!registeredListingFields.length || listingFields.length > 0 || checkingReferral) && (
            <chakra.section
              aria-label="Answers for this application"
              css={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {paused && !contextQuestions && app?.approvedRevision != null && (
                <chakra.p css={{ fontSize: "sm", color: "fg.muted" }}>Save the missing answers to resume with your approved summary.</chakra.p>
              )}
              {checkingReferral && (
                <chakra.p css={{ fontSize: "sm", color: "fg.muted" }} role="status">
                  Checking whether a referral name is needed…
                </chakra.p>
              )}
              {listingFields.length ? (
                <chakra.div
                  css={{
                    overflow: "hidden",
                    borderRadius: "lg",
                    borderWidth: "1px",
                  }}
                >
                  <chakra.p
                    css={{
                      paddingInline: "1rem",
                      paddingBlock: "0.75rem",
                      fontSize: "sm",
                      color: "fg.muted",
                    }}
                  >
                    {countSaved(listingFields)} of {listingFields.length} answers saved for this application
                  </chakra.p>
                  <chakra.ul>{listingFields.map(listingRow)}</chakra.ul>
                </chakra.div>
              ) : (
                <chakra.div
                  css={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "0.5rem",
                    borderRadius: "lg",
                    borderWidth: "1px",
                    padding: "1rem",
                    fontSize: "sm",
                    color: "fg.muted",
                  }}
                >
                  <chakra.p>
                    {registeredListingFields.length ? "No private questions for this application." : "No questions are registered for this application."}
                    {paused && " The runner can also pause at an employer-site step."}
                  </chakra.p>
                  {paused && (
                    <Button variant="outline" size="sm" onClick={refreshQuestions} disabled={questionsRefresh === "loading"}>
                      {questionsRefresh === "loading" ? "Refreshing questions…" : "Refresh questions"}
                    </Button>
                  )}
                  {questionsRefresh === "failed" && (
                    <chakra.p role="alert" css={{ color: "fg.error" }}>
                      Could not refresh questions. Try again.
                    </chakra.p>
                  )}
                </chakra.div>
              )}
            </chakra.section>
          )}
          {applicationId ? requiredShared.length > 0 && (
            <Box borderWidth="1px" rounded="lg" overflow="hidden">
              <Text px="4" py="3" textStyle="sm" color="fg.muted">Shared answers the runner asked for</Text>
              {fieldRows(requiredShared)}
            </Box>
          ) : groups.map(({ title, fields }) => (
            <chakra.section key={title} aria-label={title}>
              <HStack justify="space-between" mb="2">
                <Text textStyle="sm" fontWeight="semibold">{title}</Text>
                <Text textStyle="xs" color="fg.muted">{countGroup(fields)}</Text>
              </HStack>
              <chakra.ul borderWidth="1px" rounded="lg" overflow="hidden" css={{ "& > li:first-of-type": { borderTopWidth: 0 } }}>
                {fields.flatMap(profileRow)}
              </chakra.ul>
            </chakra.section>
          ))}
          <chakra.div
            css={{
              position: "sticky",
              bottom: 0,
              zIndex: 10,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.75rem",
              borderTopWidth: "1px",
              background: "bg",
              paddingBlock: "0.75rem",
            }}
          >
            <Button type="button" onClick={store.saveChanges}>
              Save changes
            </Button>
            {snapshot.saving && (
              <chakra.p role="status" css={{ fontSize: "sm", color: "fg.muted" }}>
                Saving changes…
              </chakra.p>
            )}
            {snapshot.pending > 0 && !snapshot.saving && !snapshot.problem && (
              <chakra.p role="status" css={{ fontSize: "sm", color: "fg.muted" }}>
                Changes ready to save.
              </chakra.p>
            )}
            {snapshot.problem && (
              <chakra.div
                css={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "0.5rem",
                  fontSize: "sm",
                }}
                role="alert"
              >
                <chakra.p css={{ color: "fg.error" }}>
                  {snapshot.problem === "conflict" ? "Some answers changed elsewhere. Apply your changes to replace them."
            : snapshot.problem === "uncertain" ? "Save unconfirmed. Retry to check the same changes."
            : "Check your answer formats, then save again."}
                </chakra.p>
                {snapshot.problem !== "invalid" && (
                  <Button type="button" size="sm" variant="outline" onClick={store.retry}>
                    {snapshot.problem === "conflict" ? "Apply changes" : "Retry save"}
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" onClick={store.discard}>
                  Discard pending changes
                </Button>
              </chakra.div>
            )}
          </chakra.div>
        </>
      )}
    </Stack>
  );
}


const StyledLink = chakra(Link);
