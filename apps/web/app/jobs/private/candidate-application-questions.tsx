"use client";

import { chakra } from "@chakra-ui/react";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { canonicalQuestionTarget, candidateQuestion, candidateQuestionAnswer, parseCandidateContext } from "../../../../../scripts/jobs/candidate-context";
import { JobsError, JobsLoading } from "../jobs-frame";
import { privateDetailsApi, type FieldMetadata } from "./private-api";
import { isPrivateField } from "./private-fields";

type Load = Awaited<ReturnType<typeof privateDetailsApi.application>> & { fields: FieldMetadata[] };

export function CandidateApplicationQuestions({ applicationId, markdown }: { applicationId: string; markdown: string }) {
  const [result, setResult] = useState<Load | "failed">();
  const [retry, setRetry] = useState(0);
  const entries = useMemo(() => parseCandidateContext(markdown), [markdown]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([privateDetailsApi.application(applicationId, signal), privateDetailsApi.metadata(applicationId, signal)]).then(
      ([details, fields]) => { if (!signal.aborted) setResult({ ...details, fields }); },
      () => { if (!signal.aborted) setResult("failed"); },
    );
    return () => controller.abort();
  }, [applicationId, retry]);

  if (!result) return <JobsLoading label="Loading application questions…" />;
  if (result === "failed") return <JobsError message="Could not load application questions." onRetry={() => {
    setResult(undefined);
    setRetry(n => n + 1);
  }} />;

  const { application, fields, candidateRules, candidateRulesUnavailable } = result;
  const groups = new Map<string, FieldMetadata[]>();
  for (const field of fields) {
    if (field.scope.kind !== "listing" || field.scope.applicationId !== applicationId) continue;
    const target = canonicalQuestionTarget(field.label, application);
    if (!target && isPrivateField(field, application, candidateRules)) continue;
    if (target && target !== "phone-device-type" && target !== "phone-country-code") continue;
    const key = target ?? candidateQuestion(application, field.label, candidateRules)?.key ?? field.key;
    const group = groups.get(key);
    if (group) group.push(field);
    else groups.set(key, [field]);
  }
  return (
    <chakra.section aria-labelledby="context-application-questions" css={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <chakra.div>
        <chakra.h2 id="context-application-questions" css={{ fontSize: "lg", fontWeight: "semibold" }}>
          Application questions
        </chakra.h2>
        <chakra.p css={{ fontSize: "sm", color: "fg.muted" }}>
          {application.role} · {application.company}
        </chakra.p>
      </chakra.div>
      {candidateRulesUnavailable && <chakra.p role="status">Configured question guidance is unavailable. You can still edit Candidate context.</chakra.p>}
      {groups.size ? (
        <chakra.ul
          css={{
            "& > * + *": { borderTopWidth: "1px" },
            borderRadius: "lg",
            borderWidth: "1px",
          }}
        >
          {[...groups].map(([key, rows]) => {
            const first = rows[0];
            if (key === "phone-device-type" || key === "phone-country-code") {
              const value = entries.get(key);
              return (
                <chakra.li
                  key={key}
                  css={{
                    paddingInline: "1rem",
                    paddingBlock: "0.75rem",
                    fontSize: "sm",
                  }}
                >
                  <chakra.p css={{ fontWeight: "medium" }}>{key === "phone-device-type" ? "Phone device type" : "Phone country calling code"}</chakra.p>
                  {value ? (
                    <chakra.p>{value}</chakra.p>
                  ) : (
                    <chakra.p>
                      Needs an answer. Set <chakra.code>{`- ${key}: …`}</chakra.code> under Application answers.
                    </chakra.p>
                  )}
                </chakra.li>
              );
            }
            const rule = candidateQuestion(application, first.label, candidateRules);
            const values = rows.map(field => rule && field.type === (rule.type === "combobox" ? "option" : "text")
          ? candidateQuestionAnswer(application, field.label, entries, field.options, candidateRules) : undefined);
            const ready = values.every(value => value !== undefined);
            const hasOverride = rows.some(field => field.hasValue);
            const canUseResumeDefault = rule?.hasResumeOnlyDefault && !entries.has(rule.key) &&
              /^yes$/i.test(entries.get("resume-only-experience") ?? "");
            return (
              <chakra.li
                key={key}
                css={{
                  paddingInline: "1rem",
                  paddingBlock: "0.75rem",
                  fontSize: "sm",
                }}
              >
                <chakra.p css={{ fontWeight: "medium" }}>{rule?.title ?? first.label}</chakra.p>
                {rule?.help && <chakra.p css={{ color: "fg.muted" }}>{rule.help}</chakra.p>}
                {hasOverride ? (
                  <chakra.p>Uses an existing saved application answer.</chakra.p>
                ) : ready ? (
                  <chakra.p>{values[0]}</chakra.p>
                ) : canUseResumeDefault ? (
                  <chakra.p>The runner checks the résumé-only default against the current form.</chakra.p>
                ) : rule ? (
                  <chakra.p>
                    Needs an answer. Set <chakra.code>{`- ${rule.key}: …`}</chakra.code> under Application answers.
                  </chakra.p>
                ) : (
                  <chakra.p>Needs review before this question can be filled automatically.</chakra.p>
                )}
              </chakra.li>
            );
          })}
        </chakra.ul>
      ) : (
        <chakra.p css={{ fontSize: "sm", color: "fg.muted" }}>No candidate context questions registered for this application.</chakra.p>
      )}
      <StyledLink
        href={{ pathname: "/jobs/private", query: { applicationId } }}
        css={{
          alignSelf: "flex-start",
          fontSize: "sm",
          textDecoration: "underline",
          textUnderlineOffset: "4px",
        }}
      >
        View reusable details
      </StyledLink>
    </chakra.section>
  );
}

const StyledLink = chakra(Link);
