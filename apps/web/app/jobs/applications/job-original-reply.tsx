"use client";

import { Button, Field, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { confirmJobReply, type JobLifecycle, type JobReplyPage, readOlderJobReplies } from "../jobs-client";

export function JobOriginalReply({ applicationId, legacyLinked, verifiedAvailable }: {
  applicationId: string; legacyLinked: boolean; verifiedAvailable: boolean;
}) {
  const href = `/api/owner/jobs/applications/${encodeURIComponent(applicationId)}/original-reply`;
  if (verifiedAvailable) return (
    <Button size="sm" variant="outline" alignSelf="start" asChild>
      <a href={href} target="_blank" rel="noreferrer">Open original reply in Roundcube<ArrowUpRightIcon /></a>
    </Button>
  );
  if (legacyLinked) return (
    <Text textStyle="sm" color="fg.muted">Reply linked. Verified original unavailable.</Text>
  );
  return null;
}

export function JobOriginalReplies({ applicationId, replies, before, canConfirm, onConfirmed }: {
  applicationId: string; replies: JobLifecycle["verifiedOriginalReplies"];
  before?: string | null; canConfirm?: boolean; onConfirmed?: () => void;
}) {
  const [older, setOlder] = useState<JobReplyPage & { offset: number }>();
  const [messageId, setMessageId] = useState("");
  const [pending, setPending] = useState<"older" | "confirm">();
  const [feedback, setFeedback] = useState<{ error: boolean; message: string }>();
  const entries = older?.replies ?? replies ?? [];
  const next = older ? older.before : before;
  const offset = older?.offset ?? 0;
  const base = `/api/owner/jobs/applications/${encodeURIComponent(applicationId)}/replies`;

  async function loadOlder() {
    if (!next || pending) return;
    setPending("older");
    setFeedback(undefined);
    try {
      setOlder({ ...await readOlderJobReplies(applicationId, next), offset: offset + entries.length });
    } catch {
      setFeedback({ error: true, message: "Could not load older replies. Try again." });
    } finally {
      setPending(undefined);
    }
  }

  async function confirm() {
    const exact = messageId.trim();
    if (!exact || pending) return;
    setPending("confirm");
    setFeedback(undefined);
    try {
      await confirmJobReply(applicationId, exact);
      setMessageId("");
      setOlder(undefined);
      onConfirmed?.();
      setFeedback({ error: false, message: "Original confirmed." });
    } catch (error) {
      setFeedback({ error: true, message: error instanceof Error ? error.message : "Could not confirm the original." });
    } finally {
      setPending(undefined);
    }
  }

  if (!entries.length && !older && !canConfirm) return null;
  return (
    <Stack gap="3">
      {!!entries.length && <Stack as="ul" gap="3" listStyleType="none" aria-label="Verified replies">
        {entries.map(({ id, confirmedAt }, index) => {
          const label = `Reply ${offset + index + 1}`;
          const confirmation = new Date(confirmedAt).toLocaleString();
          return (
            <Stack as="li" key={id} gap="1">
              <Text textStyle="sm" color="fg.muted">{label} · Confirmed <time dateTime={confirmedAt}>{confirmation}</time></Text>
              <Button size="sm" variant="outline" alignSelf="start" asChild>
                <a href={`${base}/${encodeURIComponent(id)}/original`} target="_blank" rel="noreferrer"
                  aria-label={`Open original for ${label} in Roundcube`}>
                  Open original for {label}<ArrowUpRightIcon />
                </a>
              </Button>
            </Stack>
          );
        })}
      </Stack>}
      {(older || next) && <HStack>
        {older && <Button size="xs" variant="outline" disabled={!!pending} onClick={() => setOlder(undefined)}>Newest replies</Button>}
        {next && <Button size="xs" variant="outline" disabled={!!pending} loading={pending === "older"}
          onClick={() => void loadOlder()}>Older replies</Button>}
      </HStack>}
      {canConfirm && <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
        <Stack gap="2" align="start">
          <Field.Root required>
            <Field.Label>Message-ID</Field.Label>
            <Input size="sm" value={messageId} maxLength={254} autoComplete="off" spellCheck={false}
              readOnly={pending === "confirm"} onChange={event => setMessageId(event.target.value)} />
            <Field.HelperText>Copy the Message-ID from the reply’s original headers.</Field.HelperText>
          </Field.Root>
          <Button type="submit" size="sm" disabled={!!pending || !messageId.trim()} loading={pending === "confirm"}>
            Confirm original
          </Button>
        </Stack>
      </form>}
      {feedback && <Text textStyle="sm" role={feedback.error ? "alert" : "status"}>{feedback.message}</Text>}
    </Stack>
  );
}
