import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { jobsOwnerAttestation } from '../../apps/api/src/jobs-work-contract';
import { jobsHome, readLocal } from './config';
import {
  approvedEmailClaim, emailClaim, emailMessageKey, mailSha256, prepareApprovedEmailApplication,
  prepareEmailApplication, prepareEmailContent, type ApprovedEmailClaim, type EmailClaim, type EmailPacket,
} from './email-application';
import { readEmailRoutes, type EmailRoutes } from './email-routes';
import { missingContactOutcome } from './local-files';
import { renderApprovedArtifact } from './preview';
import { sesMessageIdPattern } from './application-address';
import { deliverSes, type SesDelivery, type SesMailConfig } from './ses-transport';

const mailConfig = z.strictObject({
  region: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/).max(40),
  profile: z.string().regex(/^[a-zA-Z0-9_.@+-]{1,128}$/),
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const messageId = z.string().regex(sesMessageIdPattern);
const acceptance = z.strictObject({ binding: hash, capturedAt: z.iso.datetime() });
const attemptBinding = z.strictObject({
  number: z.number().int().positive(), workId: z.uuid(), resultId: z.uuid(), leaseTokenHash: hash, pdfSha256: hash,
});
const journal = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('pending'), messageKey: hash, digest: hash, attempt: attemptBinding.optional(),
    retryGrant: hash.optional(), sendStarted: z.literal(true).optional(),
  }),
  z.strictObject({ state: z.literal('accepted'), messageKey: hash, digest: hash, messageId, acceptance: acceptance.optional() }),
  z.strictObject({ state: z.literal('not_sent'), messageKey: hash, digest: hash, evidence: acceptance }),
]);
type Journal = z.infer<typeof journal>;
type Pending = Extract<Journal, { state: 'pending' }>;
type OwnerAttestation = z.infer<typeof jobsOwnerAttestation>;
type Delivery = (packet: EmailPacket, config: SesMailConfig) => Promise<SesDelivery>;
const unavailable = { kind: 'failed', code: 'runner_unavailable' } as const;
const uncertain = { kind: 'failed', code: 'submission_uncertain' } as const;
const sent = (sesMessageId: string) => ({ kind: 'applied', receiptCode: 'confirmation_message', sesMessageId } as const);

async function saveJournal(path: string, entry: Journal) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(entry));
    await file.sync();
  } finally { await file.close(); }
}

async function syncDirectory(directory: string) {
  const file = await open(directory, 'r');
  try { await file.sync(); }
  finally { await file.close(); }
}

async function replaceJournal(path: string, entry: Journal) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await saveJournal(temporary, entry);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export class JobsEmailJournalReadError extends Error {
  constructor() {
    super('jobs_email_journal_read_unavailable');
  }
}

async function readJournal<T>(path: string, schema: z.ZodType<T>, retryOnIoError = false): Promise<T | null | 'unreadable'> {
  const ioError = () => {
    if (retryOnIoError) throw new JobsEmailJournalReadError();
    return 'unreadable' as const;
  };
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') return 'unreadable';
    return ioError();
  }

  let raw: string;
  try {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_024 || (stat.mode & 0o077)) return 'unreadable';
      raw = await file.readFile('utf8');
    } finally { await file.close(); }
  } catch { return ioError(); }

  try { return schema.parse(JSON.parse(raw)); }
  catch { return 'unreadable'; }
}

function packetDigest(packet: EmailPacket) {
  return mailSha256(JSON.stringify([packet.messageKey, packet.from, packet.to, packet.subject, packet.body, packet.attachment.sha256]));
}

function replay(existing: Journal | null | 'unreadable', packet: EmailPacket, binding?: string) {
  if (!existing || existing === 'unreadable' || existing.state !== 'accepted' ||
    existing.messageKey !== packet.messageKey || existing.digest !== packetDigest(packet)) return uncertain;
  if (binding === undefined) return sent(existing.messageId);
  if (existing.acceptance?.binding !== binding) return uncertain;
  return { ...sent(existing.messageId), capturedAt: existing.acceptance.capturedAt };
}

async function sendWithJournal(path: string, home: string, packet: EmailPacket, deliver: (gate?: () => Promise<void>) => Promise<SesDelivery>,
  approved?: { binding: string; attempt?: Pending['attempt']; replaces?: Pending | Extract<Journal, { state: 'not_sent' }>;
    retryGrant?: string; now: () => number; beforeSend: () => Promise<void> }) {
  const directory = dirname(path);
  const { messageKey } = packet;
  const digest = packetDigest(packet);
  const pending: Pending = { state: 'pending', messageKey, digest, attempt: approved?.attempt, retryGrant: approved?.retryGrant };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (approved?.replaces) {
      const previous = approved.replaces;
      if (JSON.stringify(await readJournal(path, journal)) !== JSON.stringify(previous)) return uncertain;
      if (previous.state === 'pending' && previous.attempt) {
        const archive = join(directory, `ses-reconciled-${previous.attempt.number}.json`);
        try { await link(path, archive); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            JSON.stringify(await readJournal(archive, journal)) !== JSON.stringify(previous)) return uncertain;
        }
        await syncDirectory(directory);
      }
      await replaceJournal(path, pending);
    } else await saveJournal(path, pending);
    // A durable reservation includes any new parent directory entries.
    for (let parent = directory; parent !== home; parent = dirname(parent)) await syncDirectory(parent);
    await syncDirectory(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return uncertain;
    return replay(await readJournal(path, journal), packet, approved?.binding);
  }

  const gate = approved && (async () => {
    await approved.beforeSend();
    if (pending.retryGrant) await replaceJournal(path, { ...pending, sendStarted: true });
  });
  const outcome = await deliver(gate).catch((): SesDelivery => ({ kind: 'uncertain' }));
  const evidence = approved && { binding: approved.binding, capturedAt: new Date(approved.now()).toISOString() };
  if (outcome.kind === 'not_sent') {
    try {
      if (evidence) await replaceJournal(path, { state: 'not_sent', messageKey, digest, evidence });
      else { await rm(path); await syncDirectory(directory); }
    }
    catch { return uncertain; }
    return unavailable;
  }
  if (outcome.kind !== 'accepted' || !messageId.safeParse(outcome.messageId).success) return uncertain;

  try {
    await replaceJournal(path, { state: 'accepted', messageKey, digest, messageId: outcome.messageId, acceptance: evidence });
  } catch { /* The provider acknowledgment still confirms acceptance. */ }
  return evidence ? { ...sent(outcome.messageId), capturedAt: evidence.capturedAt } : sent(outcome.messageId);
}

type WithPrivateConfig = <T>(run: (path: string) => Promise<T>) => Promise<T>;

function journalPath(home: string, applicationId: string, approvalRevision: number) {
  return join(home, 'applications', applicationId, String(approvalRevision), 'ses-result.json');
}

async function inspectApproval({ applicationId, revision, originalApprovalRevision }: ApprovedEmailClaim) {
  const approvalRevision = originalApprovalRevision ?? revision;
  const home = resolve(jobsHome());
  const applicationDirectory = join(home, 'applications', applicationId);
  const path = journalPath(home, applicationId, approvalRevision);
  const legacyRevisions = [...new Set([revision, approvalRevision])];
  const [previous, ...legacy] = await Promise.all([
    readJournal(path, journal),
    ...legacyRevisions.map(value =>
      lstat(join(applicationDirectory, String(value), 'smtp-result.json')).then(() => true,
        (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')),
  ]);
  if (previous === 'unreadable' || legacy.some(Boolean)) return { hold: true } as const;
  return { hold: false, home, path, previous } as const;
}

type EmailOptions = { deliver?: Delivery; emailRoutes?: EmailRoutes };

export async function submitClaimEmail(work: EmailClaim, withPrivateConfig: WithPrivateConfig, {
  render = renderApprovedArtifact, deliver = deliverSes, emailRoutes,
}: EmailOptions & { render?: typeof renderApprovedArtifact }) {
  const claim = emailClaim(work);
  if (!claim.success) return unavailable;
  const { applicationId, revision, resumeTrack, summary, company, role, sourceUrl } = claim.data;
  const approvalRevision = claim.data.originalApprovalRevision ?? revision;
  const inspection = await inspectApproval(claim.data);
  if (inspection.hold) return uncertain;
  const { home, path, previous } = inspection;
  if (previous && previous.state !== 'accepted') return uncertain;
  const blocked = previous ? uncertain : unavailable;

  const mail = mailConfig.safeParse(await readLocal<unknown>('mail-ses.json').catch(() => null));
  if (!mail.success) return blocked;

  const prepared = await withPrivateConfig(async privateConfigPath => {
    const routes = emailRoutes ?? readEmailRoutes();
    const privateSnapshot: unknown = await readFile(privateConfigPath, 'utf8').then(JSON.parse).catch(() => null);
    const envelope = prepareEmailContent(claim.data, privateSnapshot, routes);
    if (envelope.kind === 'failed') return envelope;
    const { pdf } = await render({
      applicationId, revision: claim.data.previewDigest ? approvalRevision : revision, resumeTrack, summary, company, role, sourceUrl,
      ...(claim.data.resumeMarkdown ? { resumeMarkdown: claim.data.resumeMarkdown } : {}),
    }, { privateConfigPath, previewDigest: claim.data.previewDigest, emailRoutes: routes });
    return prepareEmailApplication(claim.data, privateSnapshot, { applicationId, revision, resumeTrack, pdf, sha256: mailSha256(pdf) }, routes);
  }).catch(error => missingContactOutcome(error) ?? unavailable);
  if (prepared.kind === 'failed') return previous ? uncertain : prepared;

  const { packet } = prepared;
  if (previous) return replay(previous, packet);
  return sendWithJournal(path, home, packet, () => deliver(packet, mail.data));
}

const recoveryIdentity = z.object({
  applicationId: z.uuid(), approvalRevision: z.number().int().nonnegative(),
  claimId: z.uuid(), resultId: z.uuid(), pdfSha256: hash,
});
type RecoveryIdentity = z.infer<typeof recoveryIdentity>;

function acceptanceBinding({ applicationId, approvalRevision, claimId, resultId, pdfSha256 }: RecoveryIdentity) {
  return mailSha256(JSON.stringify([applicationId, approvalRevision, claimId, resultId, pdfSha256]));
}

export async function readApprovedEmailOutcome(identity: RecoveryIdentity) {
  const validated = recoveryIdentity.safeParse(identity);
  if (!validated.success) return;
  const { applicationId, approvalRevision } = validated.data;
  const existing = await readJournal(journalPath(resolve(jobsHome()), applicationId, approvalRevision), journal, true);
  if (!existing || existing === 'unreadable' || existing.messageKey !== emailMessageKey(applicationId, approvalRevision)) return;
  const binding = acceptanceBinding(validated.data);
  if (existing.state === 'not_sent' && existing.evidence.binding === binding) return { kind: 'not_sent' } as const;
  if (existing.state !== 'accepted' || existing.acceptance?.binding !== binding) return;
  return { kind: 'accepted', receipt: { sesMessageId: existing.messageId, capturedAt: existing.acceptance.capturedAt } } as const;
}

const activeApprovals = new Set<string>();

function matchesReconciliation(previous: Pending, current: Pending['attempt'], approvalRevision: number,
  attestation: OwnerAttestation | undefined, retryGrant: string | undefined) {
  const old = previous.attempt;
  if (!old || !current || !attestation || !retryGrant ||
    attestation.previousWorkId !== old.workId || old.workId !== current.workId ||
    current.number <= old.number || current.leaseTokenHash === old.leaseTokenHash ||
    attestation.approvedRevision !== approvalRevision ||
    attestation.sha256 !== old.pdfSha256 || attestation.sha256 !== current.pdfSha256) return false;
  if (attestation.previousAttempt === old.number) {
    return (!attestation.previousResultId || attestation.previousResultId === old.resultId) &&
      attestation.previousLeaseTokenHash === old.leaseTokenHash;
  }
  // This reservation replaced the original, but a crash left it before the send gate.
  return attestation.previousAttempt < old.number && previous.retryGrant === retryGrant && !previous.sendStarted;
}

export async function submitApprovedClaimEmail(work: ApprovedEmailClaim, withPrivateConfig: WithPrivateConfig, {
  approvedPdf, resultId, attempt, ownerAttestation, beforeSend, canSend, deliver, emailRoutes, now = Date.now,
}: EmailOptions & {
  approvedPdf: { pdf: Uint8Array; sha256: string };
  resultId: string;
  attempt?: number;
  ownerAttestation?: OwnerAttestation;
  beforeSend: () => Promise<void>;
  canSend?: () => boolean;
  now?: () => number;
}) {
  const claim = approvedEmailClaim(work);
  if (!claim.success) return unavailable;
  const { id: claimId, applicationId, revision, resumeTrack } = claim.data;
  const approvalRevision = claim.data.originalApprovalRevision ?? revision;
  const key = journalPath(resolve(jobsHome()), applicationId, approvalRevision);
  // The process lock covers Mac workers; this also guards overlapping calls in one process.
  if (activeApprovals.has(key)) return uncertain;
  activeApprovals.add(key);
  try {
    const inspection = await inspectApproval(claim.data);
    if (inspection.hold) return uncertain;
    const { home, path, previous } = inspection;
    const blocked = previous ? uncertain : unavailable;
    const identity = recoveryIdentity.safeParse({
      applicationId, approvalRevision, claimId, resultId, pdfSha256: approvedPdf.sha256,
    });
    if (!identity.success) return blocked;
    const binding = acceptanceBinding(identity.data);
    const current = attemptBinding.safeParse({ number: attempt, workId: claimId, resultId,
      leaseTokenHash: mailSha256(claim.data.token), pdfSha256: approvedPdf.sha256 }).data;
    const attestation = jobsOwnerAttestation.safeParse(ownerAttestation).data;
    const retryGrant = attestation && mailSha256(JSON.stringify(attestation));
    if (previous?.state === 'pending' && !matchesReconciliation(previous, current, approvalRevision, attestation, retryGrant)) return uncertain;
    if (previous?.state === 'accepted' && previous.acceptance?.binding !== binding) return uncertain;

    const mail = mailConfig.safeParse(await readLocal<unknown>('mail-ses.json').catch(() => null));
    if (!mail.success) return previous?.state === 'accepted' ? uncertain : unavailable;
    const prepared = await withPrivateConfig(async privateConfigPath => {
      const routes = emailRoutes ?? readEmailRoutes();
      const privateSnapshot: unknown = await readFile(privateConfigPath, 'utf8').then(JSON.parse).catch(() => null);
      return prepareApprovedEmailApplication(claim.data, privateSnapshot, { ...approvedPdf, applicationId, revision, resumeTrack }, routes);
    }).catch(error => missingContactOutcome(error) ?? unavailable);
    if (prepared.kind === 'failed') return previous?.state === 'accepted' ? uncertain : prepared;

    const { packet } = prepared;
    if (previous?.state === 'pending' && (previous.messageKey !== packet.messageKey || previous.digest !== packetDigest(packet))) return uncertain;
    const send = async (gate?: () => Promise<void>): Promise<SesDelivery> => {
      if (!deliver) return deliverSes(packet, mail.data, undefined, canSend, gate);
      try { await gate?.(); }
      catch { return { kind: 'not_sent' }; }
      if (canSend && !canSend()) return { kind: 'not_sent' };
      return deliver(packet, mail.data);
    };
    const outcome = previous?.state === 'accepted' ? replay(previous, packet, binding)
      : await sendWithJournal(path, home, packet, send, { binding, attempt: current, replaces: previous ?? undefined, retryGrant, beforeSend, now });
    if (outcome.kind === 'failed') return outcome;
    return 'capturedAt' in outcome && typeof outcome.capturedAt === 'string'
      ? { ...outcome, capturedAt: outcome.capturedAt } : uncertain;
  } finally { activeApprovals.delete(key); }
}
