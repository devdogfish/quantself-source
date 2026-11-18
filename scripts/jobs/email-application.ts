import { createHash } from 'node:crypto';
import { z } from 'zod';
import { applicationAddressPattern } from './application-address';
import { tracks } from './config';
import { emailApplicationRoute, type readEmailRoutes } from './email-routes';
export { emailApplicationRoute } from './email-routes';

export const mailSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const mailAddress = z.email().max(254);
const singleLine = z.string().min(1).max(180).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u).refine(value => value.trim() === value);
const identity = z.object({ firstName: singleLine, lastName: singleLine });
const approvedClaim = z.object({
  id: z.uuid(), token: z.string().min(16).max(200), kind: z.literal('submit'), applicationId: z.uuid(), applicationAddress: z.string().regex(applicationAddressPattern),
  revision: z.number().int().nonnegative().max(2_147_483_646), resumeTrack: z.enum(tracks),
  company: z.string(), role: z.string(), sourceUrl: z.string(),
  originalApprovalRevision: z.number().int().positive().optional(),
});
const claim = approvedClaim.extend({
  token: z.uuid(), revision: approvedClaim.shape.revision.positive(),
  summary: z.string().min(1).max(2_000).refine(value => Boolean(value.trim())),
  resumeMarkdown: z.string().max(48_000).optional(),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
});
export type ApprovedEmailClaim = z.infer<typeof approvedClaim>;
export const approvedEmailClaim = (value: unknown) => approvedClaim.safeParse(value);
export type EmailClaim = z.infer<typeof claim>;
export const emailClaim = (value: unknown) => claim.safeParse(value);
const answer = z.object({ type: z.literal('text'), value: z.string().trim().min(1).max(4_000)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) });
const snapshotSchema = z.object({ personal: z.object({ email: mailAddress }).passthrough(),
  answers: z.record(z.string(), z.record(z.string(), z.unknown())).optional() });

export type EmailPacket = Readonly<{
  messageKey: string;
  applicationId: string;
  revision: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  attachment: Readonly<{ filename: 'Resume.pdf'; contentType: 'application/pdf'; sha256: string; bytes: Uint8Array }>;
}>;

type Blocked = { kind: 'failed'; code: 'unsupported_portal' | 'manual_required'; attention?: 'application_address' | 'name' | 'answers' };

// The Owner's Send decision creates this exact approved revision claim. The
// content is deterministic, with literal facts from its scoped private snapshot.
export function prepareEmailContent(work: EmailClaim, privateSnapshot: unknown, routes?: ReturnType<typeof readEmailRoutes>) {
  const current = emailClaim(work);
  return current.success ? prepareContent(current.data, privateSnapshot, routes) : { kind: 'failed', code: 'unsupported_portal' } as const;
}

export const emailMessageKey = (applicationId: string, approvalRevision: number) =>
  mailSha256(JSON.stringify([applicationId, approvalRevision, 'jobs-email-v1']));

function prepareContent(work: ApprovedEmailClaim, privateSnapshot: unknown, routes?: ReturnType<typeof readEmailRoutes>):
  { kind: 'ready'; envelope: Omit<EmailPacket, 'attachment'> } | Blocked {
  const route = emailApplicationRoute(work, routes);
  if (!route) return { kind: 'failed', code: 'unsupported_portal' } as const;
  const snapshot = snapshotSchema.safeParse(privateSnapshot);
  if (!snapshot.success || snapshot.data.personal.email !== work.applicationAddress) return { kind: 'failed', code: 'manual_required', attention: 'application_address' } as const;
  let subject = work.role;
  const body = [`Hello,\n\nPlease find my résumé attached for the ${work.role} position.`];
  if (route.subjectNamePrefix !== undefined) {
    const name = identity.safeParse(snapshot.data.personal);
    if (!name.success) return { kind: 'failed', code: 'manual_required', attention: 'name' };
    subject = `${route.subjectNamePrefix} – ${name.data.firstName} ${name.data.lastName}`;
  }
  for (const question of route.questions) {
    const saved = answer.safeParse(snapshot.data.answers?.[work.sourceUrl]?.[question]);
    if (!saved.success) return { kind: 'failed', code: 'manual_required', attention: 'answers' } as const;
    body.push(`${question}\n${saved.data.value}`);
  }
  body.push('Thank you.');
  const approvalRevision = work.originalApprovalRevision ?? work.revision;
  return { kind: 'ready', envelope: {
    messageKey: emailMessageKey(work.applicationId, approvalRevision),
    applicationId: work.applicationId,
    revision: work.revision,
    from: work.applicationAddress,
    to: route.recipient,
    subject,
    body: body.join('\n\n'),
  } } as const;
}

type EmailArtifact = { applicationId: string; revision: number; resumeTrack: EmailClaim['resumeTrack']; sha256: string; pdf: Uint8Array };

export function prepareEmailApplication(work: EmailClaim, privateSnapshot: unknown, artifact: EmailArtifact, routes?: ReturnType<typeof readEmailRoutes>) {
  return attachPdf(work, prepareEmailContent(work, privateSnapshot, routes), artifact);
}

export function prepareApprovedEmailApplication(work: ApprovedEmailClaim, privateSnapshot: unknown, artifact: EmailArtifact,
  routes?: ReturnType<typeof readEmailRoutes>) {
  const current = approvedEmailClaim(work);
  if (!current.success) return { kind: 'failed', code: 'unsupported_portal' } as const;
  return attachPdf(current.data, prepareContent(current.data, privateSnapshot, routes), artifact);
}

function attachPdf(work: ApprovedEmailClaim, prepared: ReturnType<typeof prepareContent>, artifact: EmailArtifact):
  { kind: 'ready'; packet: EmailPacket } | Blocked | { kind: 'failed'; code: 'runner_unavailable' } {
  if (prepared.kind === 'failed') return prepared;
  const { pdf } = artifact;
  if (artifact.applicationId !== work.applicationId || artifact.revision !== work.revision || artifact.resumeTrack !== work.resumeTrack ||
      !(pdf instanceof Uint8Array) || pdf.byteLength < 5 || pdf.byteLength > 16 * 1024 * 1024 ||
      Buffer.from(pdf.subarray(0, 5)).toString('ascii') !== '%PDF-') return { kind: 'failed', code: 'runner_unavailable' };
  const bytes = new Uint8Array(pdf);
  if (mailSha256(bytes) !== artifact.sha256) return { kind: 'failed', code: 'runner_unavailable' };
  return { kind: 'ready', packet: { ...prepared.envelope,
    attachment: { filename: 'Resume.pdf', contentType: 'application/pdf', sha256: artifact.sha256, bytes },
  } };
}
