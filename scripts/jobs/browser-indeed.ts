import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { withAccountBrowser } from './browser-accounts';
import type { BrowserConnection, BrowserDiscovery, BrowserResult, BrowserSubmitWork } from './browser';
import { jobsHome, readLocal } from './config';
import { localPython } from './local-files';
import { renderApprovedArtifact } from './preview';
import { readBrowserConfig, reviewedBrowserUrl } from './private-browser-config';

const text = z.string().min(1).max(400);
const reviewedPath = z.string().regex(/^\/[a-zA-Z0-9_/?=&%-]+$/).max(250);
const privateTarget = z.strictObject({
  source: reviewedBrowserUrl,
  listing: reviewedBrowserUrl,
  jobKey: z.string().regex(/^[a-f0-9]{16}$/),
  applicationId: z.uuid(),
  company: text,
  role: text,
  location: text,
  resumeTrack: z.enum(['engineering', 'web', 'admin']),
  selectionPath: z.string().regex(/^[a-z0-9_-]+\.json$/).max(160),
  resumeStage: reviewedPath,
  questionsStage: reviewedPath,
  reviewStage: reviewedPath,
  fileSelector: text,
  uploadedFileSelector: text,
  finalDisclosure: z.string().min(1).max(4_000),
  attestationStatement: z.string().min(1).max(4_000),
  attestationFields: z.array(z.strictObject({
    name: text,
    type: z.enum(['MULTISELECT', 'TEXT', 'SELECT']),
    label: z.string().min(1).max(4_000),
    options: z.array(z.tuple([text, text])).max(20),
  })).length(3).refine(fields => fields[0]?.type === 'MULTISELECT' && fields[0].options.length === 1 &&
    fields[1]?.type === 'TEXT' && fields[1].options.length === 0 &&
    fields[2]?.type === 'SELECT' && fields[2].options.length === 2),
  screeningControlNames: z.tuple([text, text, text]).refine(names => new Set(names).size === names.length),
  screeningFields: z.array(z.strictObject({
    id: text,
    label: text,
    type: z.enum(['select', 'text']),
    required: z.literal(true),
    options: z.array(text).max(30),
  })).length(3),
}).refine(target => {
  const listing = new URL(target.listing);
  return (listing.hostname === 'indeed.com' || listing.hostname.endsWith('.indeed.com')) &&
    listing.pathname === '/viewjob' && listing.search === '?jk=' + target.jobKey &&
    new Set(target.screeningFields.map(field => field.id)).size === target.screeningFields.length;
});

export function reviewedIndeedAdapter(sourceUrl: string) {
  if (!reviewedBrowserUrl.safeParse(sourceUrl).success) return;
  const target = readBrowserConfig('indeed-target.json', privateTarget);
  if (target?.source === sourceUrl) return newIndeedAdapter(target);
}

export function readReviewedIndeedScreening() {
  const target = readBrowserConfig('indeed-target.json', privateTarget);
  if (target) return newIndeedAdapter(target).screening;
}

function newIndeedAdapter(target: z.infer<typeof privateTarget>) {
  const { source, listing, jobKey, applicationId, company, role, location, resumeTrack, selectionPath,
    resumeStage, fileSelector, uploadedFileSelector, questionsStage, reviewStage, finalDisclosure,
    attestationStatement, attestationFields, screeningFields, screeningControlNames } = target;
  const finalDisclosureDigest = createHash('sha256').update(finalDisclosure).digest('hex');
  const attestationStatementDigest = createHash('sha256').update(attestationStatement).digest('hex');

  const screeningAnswer = z.strictObject({ type: z.enum(['option', 'text']), value: z.string().trim().min(1).max(120) });

  function screeningValue(field: (typeof screeningFields)[number], answers: Record<string, unknown> | undefined) {
    const parsed = screeningAnswer.safeParse(answers?.[field.label]);
    if (!parsed.success) return;
    const { type, value } = parsed.data;
    if (field.type === 'select' ? type === 'option' && field.options.includes(value)
      : type === 'text' && /^\d{1,3}(?:\.\d{1,2})?$/.test(value)) return value;
  }

  function unansweredScreening(answers: Record<string, unknown> | undefined) {
    return screeningFields.filter(field => screeningValue(field, answers) === undefined);
  }

  const selection = z.object({
    applicationId: z.literal(applicationId), sourceUrl: z.literal(source), selectedUrl: z.literal(listing),
    company: z.literal(company), role: z.literal(role), location: z.literal(location),
    ownerSelected: z.literal(true), recordSourceUnchanged: z.literal(true),
    ownerAcceptedSignupTerms: z.literal(true), accountStage: z.literal('signed_in_alias_verified'),
    accountTabId: z.string().regex(/^[A-F0-9]{32}$/),
  });
  const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
  const claim = z.object({
    id: z.uuid(), token: z.uuid(), revision: z.number().int().positive(), applicationId: z.literal(applicationId),
    resumeTrack: z.literal(resumeTrack), summary: z.string().min(1).max(2_000),
    previewDigest: sha256.nullish(),
  });
  const resultMessage = z.strictObject({
    qsJobsBrowser: z.literal('indeed_resume_stage'),
    state: z.enum(['auth', 'challenge', 'identity', 'stage', 'ready', 'already_started', 'attachment_unconfirmed',
      'resume_attached', 'resume_continue_activated', 'screening_required', 'prior_attachment_unverified']),
  });

  type IndeedWork = Pick<BrowserSubmitWork, 'sourceUrl'> & Partial<Pick<BrowserSubmitWork, 'company' | 'role'>>;
  type IndeedStage = 'attachment_unconfirmed' | 'resume_attached' | 'resume_continue_activated' | 'screening_required' |
    'contact_phone_unverified' | 'question_stage_unverified' | 'tracked_resume_preview_required' |
    'prior_attachment_unverified' | 'tracked_replacement_unconfirmed' | 'attestation_required' |
    'attestation_continue_unconfirmed' | 'screening_continue_unverified' | 'review_required' |
    'review_unverified' | 'review_pdf_unverified' | 'review_inputs_changed';
  type IndeedFailure = Extract<BrowserResult, { kind: 'failed' }> & { indeedStage?: IndeedStage; trackedResumeReplaced?: true };
  type IndeedResult = IndeedFailure | Extract<BrowserResult, { kind: 'applied' }>;

  function matchesSource(sourceUrl: string) {
    return sourceUrl === source;
  }

  function screening(work: IndeedWork) {
    if (!matchesSource(work.sourceUrl) || !matchesPosting(work)) return;
    return { listingUrl: listing, fields: screeningFields.map(field => ({ ...field, options: [...field.options] })) };
  }

  async function readSelection() {
    const info = await lstat(join(jobsHome(), selectionPath)).catch(() => undefined);
    if (!info?.isFile() || (info.mode & 0o077) || info.size > 16_384) return;
    const parsed = selection.safeParse(await readLocal<unknown>(selectionPath).catch(() => null));
    return parsed.success ? parsed.data : undefined;
  }

  async function verifiedAlias() {
    const profile = await readLocal<{ admin?: { email?: string; verifiedDelivery?: boolean } }>('category-identities.json').catch(() => null);
    const email = z.email().safeParse(profile?.admin?.email);
    if (profile?.admin?.verifiedDelivery === true && email.success) return email.data;
  }

  function matchesPosting(work: IndeedWork) {
    return (work.company === undefined || work.company === company) && (work.role === undefined || work.role === role);
  }

  async function discover(work: IndeedWork, connection: BrowserConnection): Promise<BrowserDiscovery> {
    if (!matchesSource(work.sourceUrl)) return { kind: 'failed', code: 'unsupported_portal' };
    if (!matchesPosting(work)) return { kind: 'failed', code: 'identity_mismatch' };
    const [selected, alias] = await Promise.all([readSelection(), verifiedAlias()]);
    if (!selected || !alias) return { kind: 'failed', code: 'manual_required', gate: { kind: 'authentication', url: listing } };
    const privateInput = Buffer.from(JSON.stringify({ alias }) + '\n');
    try {
      const state = await withAccountBrowser(connection, {
        tabId: selected.accountTabId, company, role, jobKey, stage: resumeStage, fileSelector, uploadedFileSelector,
        auditOnly: true, hash: '', size: 0,
      }, 'unavailable' as z.infer<typeof resultMessage>['state'] | 'unavailable', program, ({ exitCode, messages }) => {
        const result = messages.length === 1 && resultMessage.safeParse(messages[0]);
        return exitCode === 0 && result && result.success ? result.data.state : 'unavailable';
      }, privateInput);
      if (state === 'unavailable') return { kind: 'failed', code: 'runner_unavailable' };
      if (state === 'identity') return { kind: 'failed', code: 'identity_mismatch' };
      if (state === 'auth' || state === 'challenge') return { kind: 'failed', code: 'manual_required',
        gate: { kind: state === 'auth' ? 'authentication' : 'human_verification', url: listing } };
      if (state !== 'ready') return { kind: 'failed', code: 'manual_required' };
    } finally { privateInput.fill(0); }
    return { kind: 'discovered', listingUrl: listing, fields: [
      { id: 'resume-selection-file-resume-upload-radio-card-file-input', label: 'Résumé', type: 'file', required: true, options: [] },
    ] };
  }

  async function approvedPdf(path: string, work: Pick<z.infer<typeof claim>, 'revision' | 'resumeTrack' | 'summary'>) {
    const directory = await realpath(join(jobsHome(), 'applications', applicationId, String(work.revision)));
    const artifact = await realpath(path);
    if (basename(artifact) !== 'resume.pdf' || dirname(dirname(artifact)) !== directory ||
        !/^(?:pdf-[a-f0-9]{64}|render-[A-Za-z0-9]+)$/.test(basename(dirname(artifact)))) return;
    const info = await lstat(artifact);
    if (!info.isFile() || info.size < 5 || info.size > 16 * 1024 * 1024) return;
    const [pdf, rawWork, rawManifest] = await Promise.all([
      readFile(artifact), readFile(join(dirname(artifact), 'resume.work.json'), 'utf8'),
      readFile(join(dirname(artifact), 'resume.manifest.json'), 'utf8'),
    ]);
    const saved = z.object({ applicationId: z.literal(applicationId), revision: z.literal(work.revision),
      company: z.literal(company), role: z.literal(role), sourceUrl: z.literal(source),
      resumeTrack: z.literal(work.resumeTrack), summary: z.literal(work.summary) }).safeParse(JSON.parse(rawWork));
    const hash = createHash('sha256').update(pdf).digest('hex');
    const manifest = z.object({ applicationId: z.literal(applicationId), revision: z.literal(work.revision),
      sha256: z.literal(hash) }).safeParse(JSON.parse(rawManifest));
    if (!saved.success || !manifest.success || pdf.length !== info.size || pdf.subarray(0, 5).toString() !== '%PDF-') return;
    return { path: artifact, hash, size: pdf.length };
  }

  const applicationFolder = `applications/${applicationId}`;
  const attachmentMarker = `${applicationFolder}/indeed-attachment-attempt.json`;
  const resumeContinueMarker = `${applicationFolder}/indeed-resume-continue-attempt.json`;
  const contactContinueMarker = `${applicationFolder}/indeed-contact-continue-attempt.json`;
  const screeningContinueMarker = `${applicationFolder}/indeed-screening-continue-attempt.json`;
  const attestationContinueMarker = `${applicationFolder}/indeed-attestation-continue-attempt.json`;
  const attestationApprovalPath = `${applicationFolder}/indeed-attestation-approval.json`;
  const finalApprovalPath = `${applicationFolder}/indeed-final-approval.json`;
  const finalAttemptPath = `${applicationFolder}/indeed-final-submit-attempt.json`;
  const trackedAttachmentMarker = `${applicationFolder}/indeed-tracked-attachment-attempt.json`;
  const trackedContinueMarker = `${applicationFolder}/indeed-tracked-resume-continue-attempt.json`;
  const trackedProofPath = `${applicationFolder}/indeed-tracked-resume-proof.json`;
  const progressMarker = z.object({ revision: z.number().int().positive(), stage: z.string() });
  const trackedProof = progressMarker.extend({ previousRevision: z.number().int().positive(), hash: sha256 });
  const finalAttemptSchema = z.strictObject({
    revision: z.number().int().positive(), stage: z.literal('final_submit_attempted'), draftDigest: sha256,
  });

  async function readProtectedProgress(name: string) {
    const info = await lstat(join(jobsHome(), name)).catch(() => undefined);
    if (!info?.isFile() || (info.mode & 0o077) || info.size > 512) return;
    return readLocal<unknown>(name).catch(() => null);
  }

  async function readProgress(name: string) {
    return progressMarker.safeParse(await readProtectedProgress(name)).data;
  }

  async function finalAttemptExists() {
    return lstat(join(jobsHome(), finalAttemptPath)).then(() => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
  }

  async function hasAttestationApproval(work: z.infer<typeof claim>, attachmentRevision: number) {
    const approval = z.strictObject({
      applicationId: z.literal(applicationId), revision: z.literal(work.revision),
      attachmentRevision: z.literal(attachmentRevision),
      summaryDigest: z.literal(createHash('sha256').update(work.summary).digest('hex')),
      statementDigest: z.literal(attestationStatementDigest),
      electronicSignatureApproved: z.literal(true),
    }).safeParse(await readProtectedProgress(attestationApprovalPath)).success;
    if (!approval) return false;
    const [contact, screening] = await Promise.all([readProgress(contactContinueMarker), readProgress(screeningContinueMarker)]);
    return contact?.revision === attachmentRevision && contact.stage === 'optional_contact_continue_attempted' &&
      screening?.revision === attachmentRevision && screening.stage === 'factual_screening_continue_attempted';
  }

  async function signedAttestationRevision(work: z.infer<typeof claim>, attachmentRevision: number) {
    const attempt = await readProgress(attestationContinueMarker);
    if (attempt?.stage !== 'attestation_continue_attempted' || attempt.revision >= work.revision) return;
    const prior = await priorApprovedWork(work, attempt.revision);
    if (prior?.summary === work.summary && await hasAttestationApproval({ ...work, revision: attempt.revision }, attachmentRevision)) {
      return attempt.revision;
    }
  }

  async function hasFinalApproval(work: z.infer<typeof claim>, attachmentRevision: number, attachmentHash: string, attestationRevision: number) {
    if (work.previewDigest && work.previewDigest !== attachmentHash) return false;
    return z.strictObject({
      applicationId: z.literal(applicationId), revision: z.literal(work.revision),
      attachmentRevision: z.literal(attachmentRevision), attachmentHash: z.literal(attachmentHash),
      attestationRevision: z.literal(attestationRevision),
      summaryDigest: z.literal(createHash('sha256').update(work.summary).digest('hex')),
      disclosureDigest: z.literal(finalDisclosureDigest),
      finalSubmissionApproved: z.literal(true),
    }).safeParse(await readProtectedProgress(finalApprovalPath)).success;
  }

  async function matchesCurrentResumeInputs(work: z.infer<typeof claim>, attachmentRevision: number, attachmentHash: string, privateConfigPath: string) {
    const { summary, resumeTrack } = work;
    try {
      const artifact = await renderApprovedArtifact({
        applicationId, company, role, sourceUrl: source, resumeTrack, summary, revision: attachmentRevision,
      }, { privateConfigPath, previewDigest: attachmentHash });
      return createHash('sha256').update(artifact.pdf).digest('hex') === attachmentHash;
    } catch { return false; }
  }

  async function priorApprovedWork(work: z.infer<typeof claim>, revision: number) {
    const prior = z.object({
      kind: z.literal('submit'), applicationId: z.literal(applicationId), revision: z.literal(revision),
      company: z.literal(company), role: z.literal(role), sourceUrl: z.literal(source),
      resumeTrack: z.literal(work.resumeTrack), summary: z.string().min(1).max(2_000),
      previewDigest: sha256.nullish(),
    }).safeParse(await readLocal<unknown>(`${applicationFolder}/${revision}/approved.json`).catch(() => null)).data;
    if (!prior) return;
    const copyedit = prior.summary.replace(/\b2\+ years of experience\b/g, '2+ years of professional experience');
    if (work.summary === prior.summary || work.summary === copyedit) return prior;
  }

  async function matchesPriorAttempt(work: z.infer<typeof claim>) {
    const [attachment, continued] = await Promise.all([readProgress(attachmentMarker), readProgress(resumeContinueMarker)]);
    if (attachment?.stage !== 'resume_attachment_attempted' || continued?.stage !== 'resume_continue_attempted' ||
        attachment.revision !== continued.revision || attachment.revision >= work.revision) return;
    return priorApprovedWork(work, attachment.revision);
  }

  type PriorWork = NonNullable<Awaited<ReturnType<typeof priorApprovedWork>>>;

  async function priorPdf(work: PriorWork, expectedHash = work.previewDigest) {
    const directory = join(jobsHome(), applicationFolder, String(work.revision));
    const candidates = (await readdir(directory, { withFileTypes: true })).filter(entry =>
      entry.isDirectory() && /^(?:pdf-[a-f0-9]{64}|render-[A-Za-z0-9]+)$/.test(entry.name));
    if (candidates.length > 16) return;
    const matching = [];
    for (const entry of candidates) {
      const pdf = await approvedPdf(join(directory, entry.name, 'resume.pdf'), work).catch(() => undefined);
      if (pdf && (!expectedHash || expectedHash === pdf.hash)) matching.push(pdf);
    }
    if (matching.length === 1) return matching[0];
  }

  async function verifiedTrackingPdf(pdf: NonNullable<Awaited<ReturnType<typeof approvedPdf>>>, privateConfigPath: string) {
    // Reuse the renderer's annotation verifier. No PDF text, URLs or exception text leaves Python.
    const program = `
import hashlib, importlib.util, io, json, sys
from pathlib import Path
from pypdf import PdfReader
p = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location("qs_jobs_files", p["script"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
tracking = module.resume_tracking_links(json.loads(Path(p["config"]).read_text()), "admin")
with open(p["path"], "rb") as source:
    pdf = source.read(16 * 1024 * 1024 + 1)
valid = (bool(tracking) and len(pdf) <= 16 * 1024 * 1024
    and hashlib.sha256(pdf).hexdigest() == p["hash"]
    and module.pdf_tracking_verified(PdfReader(io.BytesIO(pdf)), tracking))
sys.exit(0 if valid else 1)
`;
    try {
      const child = Bun.spawn([localPython(), '-B', '-c', program], {
        stdin: new Blob([JSON.stringify({ ...pdf, config: privateConfigPath, script: fileURLToPath(new URL('./files.py', import.meta.url)) })]),
        stdout: 'ignore', stderr: 'ignore', env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      });
      return (await child.exited) === 0;
    } catch { return false; }
  }

  async function verifiedPriorReplacement(work: z.infer<typeof claim>, prior: PriorWork, privateConfigPath: string) {
    const [attachment, continued, rawProof] = await Promise.all([
      readProgress(trackedAttachmentMarker), readProgress(trackedContinueMarker),
      readProtectedProgress(trackedProofPath),
    ]);
    const proof = trackedProof.safeParse(rawProof).data;
    if (proof?.stage !== 'tracked_resume_verified' || proof.previousRevision !== prior.revision ||
        proof.revision <= prior.revision || proof.revision > work.revision ||
        attachment?.stage !== 'tracked_resume_attachment_attempted' || continued?.stage !== 'tracked_resume_continue_attempted' ||
        attachment.revision !== proof.revision || continued.revision !== proof.revision) return;
    const approved = await priorApprovedWork(work, proof.revision);
    if (approved?.previewDigest !== proof.hash || approved.summary !== work.summary) return;
    const pdf = await priorPdf(approved, proof.hash).catch(() => undefined);
    if (pdf && await verifiedTrackingPdf(pdf, privateConfigPath)) return { revision: proof.revision, hash: proof.hash };
  }

  const continuationProgram = String.raw`
import json, os, time

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
with os.fdopen(3, 'rb') as private:
    identity = json.loads(private.readline(4096))

def stage_action(action='inspect', draft_digest=None):
    data = {key: p[key] for key in ('jobKey','company','role','questionsStage','labels','attestationFields','screeningControlNames','reviewStage','finalDisclosure')}
    data.update({'alias':identity['alias'], 'phone':identity.get('phone'), 'answers':identity.get('answers'),
                 'nameParts':identity.get('nameParts'),
                 'fullName':identity.get('fullName'), 'attestationApproved':identity.get('attestationApproved'),
                 'signedRevision':p.get('signedRevision'), 'finalApproved':p.get('finalApproved'),
                 'attachmentHash':p.get('attachmentHash'), 'draftDigest':draft_digest, 'action':action})
    return js(r'''(async p => {
      const all = (root, selector) => [...root.querySelectorAll(selector)];
      const text = e => (e?.textContent ?? '').trim().replace(/\s+/g, ' ');
      const visible = e => Boolean(e?.getClientRects().length && e.getBoundingClientRect().width > 0 &&
        e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility === 'visible');
      const aliasMatches = value => typeof value === 'string' && value.trim().toLowerCase() === p.alias.toLowerCase();
      const u = new URL(location.href);
      if (u.origin === 'https://secure.indeed.com') return 'auth';
      if (u.origin !== 'https://smartapply.indeed.com' || p.action !== 'receipt' && (u.search || u.hash)) return 'stage';
      const digestText = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      const draftId = window._initialData?.smartApplyCommonMetadata?.draft?.id;
      const receiptKey = 'applySubmissionSuccessDraftId';
      if (p.action === 'receipt') {
        // The Review provider sets this to its exact draft ID only after SubmitApplication succeeds.
        const submitted = sessionStorage.getItem(receiptKey);
        return submitted && submitted.length <= 256 && p.draftDigest === await digestText(submitted) ? 'receipt_verified' : 'stage';
      }
      const headings = all(document, 'h1,h2,h3,[role=heading]').filter(visible);
      if (all(document, 'iframe[title*=captcha i],#challenge-stage,[data-sitekey]').some(visible) ||
          headings.some(e => /^(?:verify (?:that )?you are human|security verification|access denied)$/i.test(text(e)))) return 'challenge';
      const d = window._initialData;
      const sameJob = d?.jobInfo?.jk === p.jobKey && d.jobInfo.jobTitle === p.role && d.jobInfo.jobCompany === p.company;
      if (!sameJob) return 'identity';
      const nav = all(document, 'nav#gnav-burger-menu-nav');
      const configs = all(document, 'script#_indeed_gnav_config');
      if (nav.length !== 1 || configs.length !== 1 || !aliasMatches(d.authMetadata?.email)) return 'auth';
      const logout = all(nav[0], 'a[href]').filter(e => {
        const link = new URL(e.href);
        return link.origin === 'https://secure.indeed.com' && link.pathname === '/account/logout' && !link.username && !link.password;
      });
      let config;
      try { config = JSON.parse(configs[0].textContent); } catch { return 'auth'; }
      if (logout.length !== 1 || !aliasMatches(config?.userEmail) ||
          all(logout[0], 'span').filter(e => aliasMatches(text(e))).length !== 1) return 'auth';

      const label = source => {
        const inert = document.createElement('template');
        inert.innerHTML = typeof source === 'string' ? source : '';
        return text(inert.content);
      };
      const hit = target => {
        target.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const box = target.getBoundingClientRect();
        return target.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      };
      const digits = value => typeof value === 'string' && /^\+?[0-9 ().-]{7,32}$/.test(value) ? value.replace(/\D/g, '') : '';
      if (!Array.isArray(d.screenerQuestions) || d.screenerQuestions.length !== 25) return 'stage';
      const q = d.screenerQuestions;
      if (u.pathname === p.reviewStage) {
        const review = () => {
          if (!p.signedRevision || !p.attachmentHash || !p.fullName || !p.answers.every(Boolean) ||
              typeof draftId !== 'string' || !draftId || draftId.length > 256 || sessionStorage.getItem(receiptKey) === draftId ||
              headings.filter(e => text(e) === 'Review your application').length !== 1) return;
          const frames = all(document, 'main iframe[data-testid=application-preview][srcdoc]').filter(visible);
          const final = all(document, 'main button[type=submit],main input[type=submit]').filter(visible);
          const submit = final[0];
          if (frames.length !== 1 || final.length !== 1 || submit.tagName !== 'BUTTON' ||
              submit.dataset.testid !== 'submit-application-button' || text(submit) !== 'Submit your application' ||
              submit.matches(':disabled') || submit.getAttribute('aria-disabled') === 'true') return;
          const disclosures = all(document, 'main [data-testid=legalDisclaimer]').filter(visible);
          const disclaimer = disclosures.length === 1 && all(disclosures[0], 'p[data-testid=indeedLegalDisclaimer]').filter(visible);
          const links = disclaimer?.length === 1 && all(disclaimer[0], 'a[href]');
          if (!links || links.length !== 1 || text(disclaimer[0]) !== p.finalDisclosure ||
              text(links[0]) !== 'Terms, Cookie & Privacy Policies') return;
          const policy = new URL(links[0].href);
          if (!['http:','https:'].includes(policy.protocol) || policy.hostname !== 'ca.indeed.com' ||
              policy.pathname !== '/legal' || policy.username || policy.password || policy.port ||
              policy.searchParams.get('hl') !== 'en_CA') return;
          const controls = all(document, 'main input,main select,main textarea,[role=checkbox]').filter(visible);
          const alerts = controls[0];
          if (controls.length !== 1 || alerts.type !== 'checkbox' || alerts.checked || alerts.required ||
              alerts.labels?.length !== 1 ||
              text(alerts.labels[0]) !== 'Get email updates for the latest billing coordinator jobs in London, ON') return;
          const frame = frames[0], doc = frame.contentDocument;
          if (!doc) return;
          const pairs = (section, title) => {
            const sections = all(doc, 'section[data-testid=' + section + ']');
            if (sections.length !== 1 || text(sections[0].querySelector('h2')) !== title) return [];
            return all(sections[0], 'dt').map(term => [
              text(term), term.nextElementSibling?.tagName === 'DD' ? text(term.nextElementSibling) : null,
            ]);
          };
          const contact = pairs('contactInfoSection', 'Contact information');
          const phone = digits(p.phone);
          if (contact.map(([key]) => key).join('|') !== 'First name|Last name|Full name|E-mail|Phone number' ||
              !p.nameParts || contact[0][1] !== p.nameParts[0] || contact[1][1] !== p.nameParts[1] || contact[2][1] !== p.fullName ||
              !aliasMatches(contact[3][1]) || !phone || digits(contact[4][1]) !== phone) return;
          const questions = pairs('screenerQuestionsSection', 'Questions from the employer');
          const expected = [
            [label(q[2].labelHtml), phone], [label(q[5].labelHtml), phone],
            ...p.labels.map((name, i) => [name, p.answers[i]]),
            [p.attestationFields[0].label, p.attestationFields[0].options[0][0]],
            [p.attestationFields[1].label, p.fullName], [p.attestationFields[2].label, 'Yes'],
          ];
          if (questions.length !== expected.length || !expected.every(([key, answer], i) =>
              questions[i][0] === key && (i < 2 ? digits(questions[i][1]) : questions[i][1]) === answer)) return;
          const download = all(doc, 'section[data-testid=resumeSection] a[download="resume.pdf"][href]');
          if (download.length !== 2 || download.filter(e => text(e) === 'resume.pdf').length !== 1 ||
              download[0].href !== download[1].href) return;
          const attachment = new URL(download[0].href);
          if (attachment.origin !== 'https://apply-preview.indeed.com' || attachment.username || attachment.password ||
              attachment.pathname !== '/indeedapply/applicationpreview/attachment' || !attachment.search || attachment.hash) return;
          return { submit, frame, doc, attachment };
        };
        const verified = review();
        if (!verified) return 'review_unverified';
        if (p.action === 'inspect') return 'review_required';
        if (!p.finalApproved) return 'review_unverified';
        const digest = await digestText(draftId);
        if (p.action === 'review_draft') return digest;
        if (p.action !== 'review_submit' || p.draftDigest !== digest) return 'review_unverified';
        try {
          const response = await fetch(verified.attachment.href, {
            credentials:'include', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(7000),
          });
          if (!response.ok) return 'review_pdf_unverified';
          const pdf = await response.arrayBuffer();
          if (pdf.byteLength < 5 || pdf.byteLength > 16 * 1024 * 1024 ||
              new TextDecoder().decode(pdf.slice(0,5)) !== '%PDF-') return 'review_pdf_unverified';
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pdf))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (digest !== p.attachmentHash) return 'review_pdf_unverified';
        } catch { return 'review_pdf_unverified'; }
        const current = review();
        if (!current || current.submit !== verified.submit || current.frame !== verified.frame ||
            current.doc !== verified.doc || current.attachment.href !== verified.attachment.href ||
            window._initialData?.smartApplyCommonMetadata?.draft?.id !== draftId ||
            location.pathname !== p.reviewStage || !hit(current.submit)) return 'review_unverified';
        HTMLElement.prototype.click.call(current.submit);
        return 'final_submit_activated';
      }
      if (headings.filter(e => text(e) === 'Answer these questions from the employer').length !== 1) return 'stage';
      if (!p.labels.every((expected, i) => q[i + 8].required === true && label(q[i + 8].labelHtml) === expected &&
          q[i + 8].type === (i < 2 ? 'SELECT' : 'TEXT'))) return 'stage';
      const nextButton = (allowDisabled = false) => {
        const buttons = all(document, 'button,input[type=submit],[role=button]').filter(visible);
        if (buttons.some(e => /^(?:apply|apply now|submit|submit application|send application)$/i.test(text(e) || e.getAttribute('value') || ''))) return null;
        const next = buttons.filter(e => e.tagName === 'BUTTON' && e.type === 'button' && text(e) === 'Continue');
        return next.length === 1 && (allowDisabled || !next[0].matches(':disabled') &&
          next[0].getAttribute('aria-disabled') !== 'true') ? next[0] : null;
      };
      if (u.pathname === p.questionsStage + '/questions/3') {
        if (all(document, 'strong').filter(e => visible(e) && text(e) === 'Attestations').length !== 1 ||
            !p.attestationFields.every((expected, i) => {
              const actual = q[i + 22];
              return actual.name === expected.name && actual.type === expected.type && actual.format === 'NONE' &&
                actual.required === true && label(actual.labelHtml) === expected.label &&
                Array.isArray(actual.options) && actual.options.length === expected.options.length &&
                expected.options.every(([label, value]) => actual.options.filter(e => e.label === label && e.value === value).length === 1);
            })) return 'stage';
        const [signName, fullName, reviewName] = p.attestationFields.map(e => e.name);
        const condition = q[23].condition;
        if (!q[22].id || condition?.id !== q[22].id || condition.exclude !== false ||
            !Array.isArray(condition.values) || condition.values.length !== 1 ||
            condition.values[0] !== 'attestationSign') return 'stage';
        const inputs = all(document, 'input[name^=q_],textarea[name^=q_],select[name^=q_]');
        const pick = (name, type) => inputs.filter(e => e.name === name && e.tagName === 'INPUT' && e.type === type &&
          !e.matches(':disabled') && !e.readOnly);
        const sign = pick(signName, 'checkbox');
        const names = pick(fullName, 'text');
        const ai = pick(reviewName, 'radio');
        if (sign.length !== 1 || ai.length !== 2 ||
            sign[0].value !== 'attestationSign' || sign[0].labels?.length !== 1 ||
            text(sign[0].labels[0]) !== p.attestationFields[0].options[0][0] ||
            !p.attestationFields[2].options.every(([choice, value]) => ai.filter(e =>
              e.value === value && e.labels?.length === 1 && text(e.labels[0]) === choice).length === 1)) return 'stage';
        const optOut = ai.find(e => e.value === 'Y');
        const hasName = typeof p.fullName === 'string' && p.fullName.length > 0;
        if (sign[0].checked && names.length === 0 && inputs.length === 3 && p.action === 'attestation_fill_name') {
          return 'attestation_control_pending';
        }
        if (inputs.length !== (sign[0].checked ? 4 : 3) || names.length !== (sign[0].checked ? 1 : 0) ||
            (names[0] && (!visible(names[0]) || names[0].value.trim() &&
              (!hasName || names[0].value.trim() !== p.fullName)))) return 'stage';
        if (p.action === 'inspect') return optOut.checked ? 'attestation_required' : 'attestation_opt_out_ready';
        if (p.action === 'attestation_opt_out') {
          if (!optOut.checked) {
            if (!hit(optOut.labels[0])) return 'attestation_control_pending';
            HTMLElement.prototype.click.call(optOut);
          }
          return 'attestation_opt_out_selected';
        }
        if (!p.attestationApproved || !hasName || !optOut.checked) return 'stage';
        if (p.action === 'attestation_fill_name' && sign[0].checked) {
          if (names[0].value !== p.fullName) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(names[0], p.fullName);
            names[0].dispatchEvent(new Event('input', { bubbles: true }));
            names[0].dispatchEvent(new Event('change', { bubbles: true }));
          }
          return 'attestation_name_filled';
        }
        if (p.action === 'attestation_check') {
          if (!sign[0].checked) {
            if (!hit(sign[0].labels[0])) return 'attestation_control_pending';
            HTMLElement.prototype.click.call(sign[0]);
          }
          return 'attestation_checked';
        }
        if (p.action !== 'attestation_continue' || !sign[0].checked) return 'stage';
        const next = nextButton(true);
        if (!next) return 'stage';
        if (names[0].value !== p.fullName || next.matches(':disabled') ||
            next.getAttribute('aria-disabled') === 'true' || !hit(next)) return 'attestation_control_pending';
        HTMLElement.prototype.click.call(next);
        return 'attestation_continue_activated';
      }
      if (u.pathname === p.questionsStage + '/questions/2') {
        const expectedNames = p.screeningControlNames;
        if (!expectedNames.every((name, i) => q[i + 8].name === name) || q[10].format !== 'DECIMAL' ||
            all(document, 'strong').filter(e => visible(e) && text(e) === 'Questions').length !== 1) return 'stage';
        const choices = name => {
          const groups = all(document, 'fieldset[role=radiogroup][aria-required=true]').filter(e => e.name === name &&
            e.getAttribute('data-testid') === 'input-' + name && visible(e));
          const inputs = all(document, 'input[type=radio]').filter(e => e.name === name);
          if (groups.length !== 1 || inputs.length !== 2 || !inputs.every(e => groups[0].contains(e) && !e.matches(':disabled') &&
              e.getAttribute('data-testid')?.startsWith('input-' + name + '-single-select-question-') && e.labels?.length === 1)) return null;
          if (inputs.map(e => text(e.labels[0])).sort().join(',') !== 'No,Yes') return null;
          return inputs;
        };
        const groups = expectedNames.slice(0, 2).map(choices);
        const numbers = all(document, 'input[type=text]').filter(e => e.name === expectedNames[2] &&
          e.getAttribute('data-testid') === 'input-' + expectedNames[2] + '-input' && visible(e) && !e.matches(':disabled') && !e.readOnly);
        if (groups.some(e => !e) || numbers.length !== 1) return 'stage';
        const optional = q.slice(11, 20);
        if (optional.some(field => field.required || !/^q_[a-f0-9]{32}$/.test(field.name))) return 'stage';
        const optionalNames = new Set(optional.map(field => field.name));
        if (all(document, 'input,select,textarea').some(e => optionalNames.has(e.name) &&
            (['radio','checkbox'].includes(e.type) ? e.checked : Boolean(e.value?.trim())))) return 'stage';
        const currency = all(document, '[role=combobox]').filter(e =>
          e.getAttribute('data-testid') === 'input-' + q[14].name + '-select-list-select-list' && visible(e));
        if (currency.length !== 1 || currency[0].getAttribute('aria-expanded') !== 'false' ||
            !['Select an option','Select','Select your currency type','Select currency',''].includes(text(currency[0]))) return 'stage';
        if (!p.answers || !p.answers.slice(0, 2).every(answer => answer === 'Yes' || answer === 'No') ||
            typeof p.answers[2] !== 'string' || !/^\d{1,3}(?:\.\d{1,2})?$/.test(p.answers[2])) {
          return p.action === 'inspect' && nextButton() ? 'screening_required' : 'stage';
        }
        const radios = groups.map((group, i) => group.find(e => text(e.labels[0]) === p.answers[i]));
        if (p.action === 'inspect') return nextButton() ? 'screening_ready' : 'stage';
        if (/^fill[0-2]$/.test(p.action)) {
          const field = Number(p.action.at(-1));
          if (field < 2) {
            const radio = radios[field];
            if (!radio.checked) {
              if (!hit(radio.labels[0])) return 'screening_control_pending';
              HTMLElement.prototype.click.call(radio);
            }
          } else if (numbers[0].value !== p.answers[2]) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(numbers[0], p.answers[2]);
            numbers[0].dispatchEvent(new Event('input', { bubbles: true }));
            numbers[0].dispatchEvent(new Event('change', { bubbles: true }));
          }
          return 'screening_filled';
        }
        if (p.action !== 'screening_continue') return 'stage';
        const next = nextButton(true);
        if (!next) return 'stage';
        if (!radios.every(e => e.checked) || numbers[0].value !== p.answers[2] || next.matches(':disabled') ||
            next.getAttribute('aria-disabled') === 'true' || !hit(next)) return 'screening_control_pending';
        HTMLElement.prototype.click.call(next);
        return 'screening_continue_activated';
      }
      if (u.pathname !== p.questionsStage + '/questions/1') return 'stage';
      if (all(document, 'strong').filter(e => visible(e) && text(e) === 'Contact Information').length !== 1 ||
          q.slice(0, 7).map(field => field.type).join(',') !== 'INFORMATION,SELECT,TEXT,MULTISELECT,SELECT,TEXT,PAGEBREAK' ||
          q.slice(0, 7).some(field => field.required) || ![2, 3, 5].every(i => /^q_[a-f0-9]{32}$/.test(q[i].name))) return 'stage';
      const inputs = all(document, 'input[name^=q_],select[name^=q_],textarea[name^=q_]');
      const inputFor = (i, type) => inputs.filter(e => e.name === q[i].name && e.tagName === 'INPUT' && e.type === type && visible(e));
      const [mobile, sms, home] = [inputFor(2, 'text'), inputFor(3, 'checkbox'), inputFor(5, 'text')];
      if (inputs.length !== 3 || [mobile, sms, home].some(group => group.length !== 1) || sms[0].checked) return 'stage';
      const phone = digits(p.phone);
      if ([mobile[0], home[0]].some(e => e.value.trim() && (!phone || digits(e.value.trim()) !== phone))) {
        return 'contact_phone_unverified';
      }
      const next = nextButton();
      if (!next) return 'stage';
      if (p.action === 'inspect') return 'contact_ready';
      if (p.action !== 'contact_continue') return 'stage';
      if (!hit(next)) return 'contact_control_pending';
      HTMLElement.prototype.click.call(next);
      return 'contact_continue_activated';
    })(''' + json.dumps(data) + ')')

def advance(marker, marker_stage, action, wait_status, success, next_stages):
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return 'stage'
    with os.fdopen(fd, 'w') as attempt:
        json.dump({'revision':p['attachmentRevision'], 'stage':marker_stage}, attempt)
        attempt.flush()
        os.fsync(attempt.fileno())
    for _ in range(8):
        state = stage_action(action)
        if state != wait_status:
            break
        time.sleep(.2)
    if state != success:
        os.unlink(marker)
        if state == 'screening_control_pending':
            return 'screening_continue_unverified'
        return 'stage' if state == wait_status else state
    for _ in range(16):
        time.sleep(.25)
        state = stage_action()
        if state in next_stages:
            return state
    return 'stage'

def run():
    isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
    tabs = [t for t in cdp('Target.getTargets')['targetInfos'] if t['type'] == 'page' and
            t['targetId'] == p['tabId'] and t.get('browserContextId') not in isolated]
    if len(tabs) != 1:
        return 'auth'
    switch_tab(tabs[0]['targetId'], activate=False)
    if os.path.lexists(p['finalMarker']):
        prior_digest = p.get('priorFinalDraftDigest')
        return 'receipt_verified' if prior_digest and stage_action('receipt', prior_digest) == 'receipt_verified' else 'submission_uncertain'
    state = stage_action()
    if state == 'review_required' and p.get('finalApproved'):
        draft_digest = stage_action('review_draft')
        if not isinstance(draft_digest, str) or len(draft_digest) != 64 or any(ch not in '0123456789abcdef' for ch in draft_digest):
            return 'review_unverified'
        try:
            fd = os.open(p['finalMarker'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return 'submission_uncertain'
        with os.fdopen(fd, 'w') as attempt:
            json.dump({'revision':p['claimRevision'], 'stage':'final_submit_attempted','draftDigest':draft_digest}, attempt)
            attempt.flush()
            os.fsync(attempt.fileno())
        submitted = stage_action('review_submit', draft_digest)
        if submitted in ('review_unverified', 'review_pdf_unverified'):
            os.unlink(p['finalMarker'])
            return submitted
        if submitted != 'final_submit_activated':
            return 'submission_uncertain'
        for _ in range(24):
            time.sleep(.4)
            if stage_action('receipt', draft_digest) == 'receipt_verified':
                return 'receipt_verified'
        return 'submission_uncertain'
    if state == 'contact_ready':
        state = advance(p['contactMarker'], 'optional_contact_continue_attempted', 'contact_continue',
                        'contact_control_pending', 'contact_continue_activated', ('screening_required','screening_ready'))
    if state == 'screening_required' and (os.path.lexists(p['screeningMarker']) or os.path.lexists(p['attestationMarker'])):
        return 'stage'
    if state == 'screening_ready':
        for i in range(3):
            if control('fill' + str(i), 'screening_control_pending') != 'screening_filled':
                return 'stage'
        state = advance(p['screeningMarker'], 'factual_screening_continue_attempted', 'screening_continue',
                        'screening_control_pending', 'screening_continue_activated',
                        ('attestation_required','attestation_opt_out_ready'))
    if state == 'attestation_opt_out_ready':
        if control('attestation_opt_out', 'attestation_control_pending') != 'attestation_opt_out_selected':
            return 'stage'
        state = stage_action()
    if state != 'attestation_required' or not identity.get('attestationApproved') or not identity.get('fullName'):
        return state
    try:
        fd = os.open(p['attestationMarker'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return 'attestation_continue_unconfirmed'
    with os.fdopen(fd, 'w') as attempt:
        json.dump({'revision':p['claimRevision'], 'stage':'attestation_continue_attempted'}, attempt)
        attempt.flush()
        os.fsync(attempt.fileno())
    if (control('attestation_check', 'attestation_control_pending') != 'attestation_checked' or
        control('attestation_fill_name', 'attestation_control_pending') != 'attestation_name_filled' or
        control('attestation_continue', 'attestation_control_pending') != 'attestation_continue_activated'):
        return 'attestation_continue_unconfirmed'
    return 'attestation_continue_unconfirmed'

def control(action, pending):
    for _ in range(8):
        state = stage_action(action)
        if state != pending:
            return state
        time.sleep(.2)
    return 'stage'

try:
    state = run()
except Exception:
    state = 'submission_uncertain' if os.path.lexists(p['finalMarker']) else 'stage'
print(json.dumps({'qsJobsBrowser':'indeed_questions_stage','state':state}), flush=True)
`;

  const continuationMessage = z.strictObject({
    qsJobsBrowser: z.literal('indeed_questions_stage'),
    state: z.enum(['auth', 'challenge', 'identity', 'stage', 'screening_required', 'contact_phone_unverified', 'attestation_required',
      'attestation_continue_unconfirmed', 'screening_continue_unverified', 'review_required', 'review_unverified',
      'review_pdf_unverified', 'receipt_verified', 'submission_uncertain']),
  });

  async function continueWasteSolutionsIndeed(
    options: BrowserConnection, tabId: string, alias: string, phone: unknown, attachmentRevision: number,
    answers: Record<string, unknown> | undefined, work: z.infer<typeof claim>, name: string | undefined,
    nameParts: [string, string] | undefined, privateConfigPath: string, attachmentHash?: string,
  ): Promise<IndeedResult> {
    const blocked = { kind: 'failed', code: 'manual_required' } as const;
    const factualAnswers = screeningFields.map(field => screeningValue(field, answers) ?? null);
    const attestationApproved = Boolean(attachmentHash && name) && factualAnswers.every(answer => answer !== null) &&
      await hasAttestationApproval(work, attachmentRevision);
    const signedRevision = attachmentHash && await signedAttestationRevision(work, attachmentRevision);
    const finalConsent = Boolean(attachmentHash && signedRevision &&
      await hasFinalApproval(work, attachmentRevision, attachmentHash, signedRevision));
    const finalApproved = Boolean(attachmentHash && finalConsent &&
      await matchesCurrentResumeInputs(work, attachmentRevision, attachmentHash, privateConfigPath));
    const finalMarker = join(jobsHome(), finalAttemptPath);
    const finalAttempt = finalAttemptSchema.safeParse(await readProtectedProgress(finalAttemptPath)).data;
    const priorFinalDraftDigest = finalAttempt && attachmentHash && signedRevision &&
      (await priorApprovedWork(work, finalAttempt.revision))?.summary === work.summary &&
      await hasFinalApproval({ ...work, revision: finalAttempt.revision }, attachmentRevision, attachmentHash, signedRevision)
      ? finalAttempt.draftDigest : undefined;
    const input = Buffer.from(JSON.stringify({
      alias, phone: typeof phone === 'string' && phone.length <= 32 ? phone : null,
      fullName: name, nameParts, attestationApproved, answers: factualAnswers,
    }) + '\n');
    try {
      const result = await withAccountBrowser<IndeedResult>(options, {
        tabId, company, role, jobKey, questionsStage, attachmentRevision, labels: screeningFields.map(field => field.label), screeningControlNames,
        claimRevision: work.revision, attestationFields, attestationMarker: join(jobsHome(), attestationContinueMarker),
        reviewStage, finalDisclosure, signedRevision, finalApproved, attachmentHash, finalMarker, priorFinalDraftDigest,
        contactMarker: join(jobsHome(), contactContinueMarker), screeningMarker: join(jobsHome(), screeningContinueMarker),
      }, { kind: 'failed', code: 'runner_unavailable' }, continuationProgram, ({ exitCode, messages }) => {
        const parsed = messages.length === 1 && continuationMessage.safeParse(messages[0]);
        if (exitCode !== 0 || !parsed || !parsed.success) return { ...blocked, indeedStage: 'question_stage_unverified' };
        const { state } = parsed.data;
        if (state === 'screening_required') return {
          ...blocked, indeedStage: state, safeToResume: true, attention: { questions: unansweredScreening(answers), variables: [] },
        };
        if (state === 'contact_phone_unverified' || state === 'screening_continue_unverified') return { ...blocked, indeedStage: state };
        if (state === 'attestation_required' || state === 'attestation_continue_unconfirmed') return { ...blocked, indeedStage: state };
        if (state === 'review_required') return { ...blocked, indeedStage: finalConsent && !finalApproved ? 'review_inputs_changed' : state };
        if (state === 'review_unverified' || state === 'review_pdf_unverified') return { ...blocked, indeedStage: state };
        if (state === 'receipt_verified') return { kind: 'applied', receiptCode: 'confirmation_message' };
        if (state === 'submission_uncertain') return { kind: 'failed', code: state };
        if (state === 'auth' || state === 'challenge') return {
          ...blocked, gate: { kind: state === 'auth' ? 'authentication' : 'human_verification', url: listing },
        };
        return { ...blocked, indeedStage: 'question_stage_unverified' };
      }, input);
      if (result.kind === 'failed' && await finalAttemptExists()) {
        return { kind: 'failed', code: 'submission_uncertain' };
      }
      return result;
    } finally { input.fill(0); }
  }

  const program = String.raw`
import json, os, time

p = json.loads(os.environ['QS_JOBS_BROWSER_INPUT'])
with os.fdopen(3, 'rb') as private:
    alias = json.loads(private.readline(1024))['alias']

def inspect(audit):
    data = {key: p[key] for key in ('role','company','jobKey','stage','fileSelector','uploadedFileSelector','hash','size')}
    data.update({'alias':alias, 'audit':audit, 'prior':p.get('prior')})
    return r'''(p => {
      const visible = e => Boolean(e?.getClientRects().length && e.getBoundingClientRect().width > 0 &&
        e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility === 'visible');
      const all = (root, selector) => [...root.querySelectorAll(selector)];
      const text = e => (e?.textContent ?? '').trim().replace(/\s+/g, ' ');
      const aliasMatches = value => typeof value === 'string' && value.trim().toLowerCase() === p.alias.toLowerCase();
      const formSelector = 'form[data-testid=resume-selection-form]';
      const buttonSelector = 'button[data-testid=continue-button]';
      const previewFile = preview => {
        if (!preview) return undefined;
        const key = Object.keys(preview).find(name => name.startsWith('__reactFiber$'));
        let fiber = key && preview[key];
        const files = new Set();
        // These active component props hold the exact PDF that backs the portal preview.
        for (let depth = 0; depth < 5 && fiber; depth++, fiber = fiber.return) {
          if (depth >= 3 && fiber.memoizedProps?.file instanceof File) files.add(fiber.memoizedProps.file);
        }
        return files.size === 1 ? [...files][0] : undefined;
      };
      const digest = async file => {
        const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      };
      const inspect = (uploaded = false) => {
        const u = new URL(location.href);
        if (u.origin === 'https://secure.indeed.com') return 'auth';
        if (u.origin !== 'https://smartapply.indeed.com' || u.pathname !== p.stage || u.search || u.hash) return 'stage';
        const headings = all(document, 'h1,h2,h3,[role=heading]').filter(visible);
        if (all(document, 'iframe[title*=captcha i],#challenge-stage,[data-sitekey]').some(visible) ||
            headings.some(e => /^(?:verify (?:that )?you are human|security verification|access denied)$/i.test(text(e)))) return 'challenge';

        // Read the job identity from the current SmartApply application.
        const data = window._initialData;
        if (data?.jobInfo?.jk !== p.jobKey || data.jobInfo.jobTitle !== p.role || data.jobInfo.jobCompany !== p.company ||
            headings.filter(e => text(e) === p.role).length !== 1) return 'identity';

        // The account logout control contains the alias even with the menu collapsed.
        const nav = all(document, 'nav#gnav-burger-menu-nav');
        const configs = all(document, 'script#_indeed_gnav_config');
        if (nav.length !== 1 || configs.length !== 1 || !aliasMatches(data.authMetadata?.email)) return 'auth';
        const logout = all(nav[0], 'a[href]').filter(e => {
          const link = new URL(e.href);
          return link.origin === 'https://secure.indeed.com' && link.pathname === '/account/logout' &&
            !link.username && !link.password;
        });
        let config;
        try { config = JSON.parse(configs[0].textContent); } catch { return 'auth'; }
        if (logout.length !== 1 || !aliasMatches(config?.userEmail) ||
            all(logout[0], 'span').filter(e => aliasMatches(text(e))).length !== 1) return 'auth';

        const forms = all(document, formSelector);
        const inputs = all(document, uploaded ? p.uploadedFileSelector : p.fileSelector);
        const buttons = all(document, buttonSelector);
        if (forms.length !== 1 || inputs.length !== 1 || buttons.length !== 1) return 'stage';
        const [form] = forms, [input] = inputs, [next] = buttons;
        const action = new URL(form.action);
        const entry = window.navigation?.currentEntry?.key;
        if (!entry || !visible(form) || action.origin !== u.origin || action.pathname !== p.stage || action.search || action.hash ||
            form.method !== 'get' || all(form, 'h1').filter(e => visible(e) && text(e) === 'Add a resume').length !== 1 ||
            all(document, 'input[type=file]').length !== 1 || !form.contains(input) || input.form !== form || input.matches(':disabled') ||
            input.multiple || (!uploaded && !input.accept.split(',').some(type => type.trim().toLowerCase() === 'application/pdf')) ||
            !form.contains(next) || next.form !== form || next.type !== 'button' || text(next) !== 'Continue' || !visible(next) ||
            all(document, 'button,input[type=submit],[role=button]').some(e => visible(e) &&
              /^(?:apply|apply now|submit|submit application|send application)$/i.test(text(e) || e.getAttribute('value') || '')) ||
            all(form, 'input:not([type=hidden]):not([type=file]),textarea,select').some(e => visible(e) &&
              !(uploaded && e.matches('input[type=number][data-testid=resume-selection-file-resume-pdf-preview-page-input]')))) return 'stage';
        let previewReady = false, preview;
        if (uploaded) {
          const cards = all(form, '[data-testid=resume-selection-file-resume-radio-card]');
          if (cards.length !== 1 || !cards[0].contains(input) || input.files?.length > (p.prior ? 1 : 0)) return 'stage';
          const card = cards[0];
          const radios = all(card, 'input[type=radio][data-testid=resume-selection-file-resume-radio-card-input]');
          const labels = all(card, 'label[data-testid=resume-selection-file-resume-radio-card-label]');
          const previews = all(card, 'section[data-testid=resume-selection-file-resume-pdf-preview]');
          if (radios.length !== 1 || labels.length !== 1 || previews.length > 1) return 'stage';
          [preview] = previews;
          if (p.prior) {
            const menus = all(document, 'button[data-testid=ResumeOptionsMenu]');
            const upload = all(document, 'button[data-testid=ResumeOptionsMenu-upload]');
            if (menus.length !== 1 || upload.length !== 1 || !card.contains(menus[0]) || !card.contains(upload[0]) ||
                text(menus[0]) !== 'Resume options' || text(upload[0]) !== 'Upload a different file' ||
                menus[0].type !== 'button' || upload[0].type !== 'button') return 'stage';
          }
          previewReady = radios[0].checked && text(labels[0]) === 'resume.pdf' && preview && visible(preview) &&
            (p.prior ? Boolean(previewFile(preview)) :
              all(preview, 'canvas[data-testid=resume-selection-file-resume-pdf-preview-page-canvas]').some(visible));
        }
        return { data, entry, form, input, next, preview, previewReady };
      };
      const stage = inspect(Boolean(p.prior));
      if (typeof stage === 'string') return stage;
      if (stage.input.files?.length !== 0) return 'already_started';
      if (p.audit) return 'ready';
      const sameApplication = current => typeof current === 'object' && current.data === stage.data && current.entry === stage.entry;
      const sameDocument = current => sameApplication(current) && current.form === stage.form && current.next === stage.next;
      const sameUpload = p.prior ? sameApplication : sameDocument;
      const sameStage = () => {
        const current = inspect(Boolean(p.prior));
        return sameDocument(current) && current.input === stage.input && current.preview === stage.preview;
      };
      let selectedFile, startedAt;
      const captureFile = () => {
        if (stage.input.files?.length === 1) selectedFile ??= stage.input.files[0];
      };
      const uploadAccepted = () => performance.getEntriesByType('resource').filter(e => {
        const u = new URL(e.name);
        const uploadPath = p.prior ? u.pathname === '/api/v1/file-resumes/process'
          : u.pathname.startsWith('/api/v1/') && u.pathname.includes('resume');
        return e.startTime >= startedAt && u.origin === location.origin && uploadPath &&
          e.initiatorType === 'xmlhttprequest' && e.responseStatus === 201;
      }).length === 1;

      return {
        async attachmentTarget() {
          if (!sameStage() || stage.input.files?.length !== 0) return null;
          if (p.prior) {
            const previousFile = previewFile(stage.preview);
            if (!stage.previewReady || !previousFile || previousFile.name !== 'resume.pdf' || previousFile.size !== p.prior.size ||
                await digest(previousFile) !== p.prior.hash || !sameStage() || previewFile(stage.preview) !== previousFile ||
                stage.input.files?.length !== 0) return null;
          }
          startedAt = performance.now();
          // Capture the native File before Indeed's handler replaces the upload control.
          stage.input.addEventListener('input', captureFile, { capture: true, once: true });
          stage.input.addEventListener('change', captureFile, { capture: true, once: true });
          return stage.input;
        },
        async continueAfterVerification(activate) {
          const current = inspect(true);
          if (!sameUpload(current)) return sameStage() ? 'upload_pending' : 'attachment_unconfirmed';
          if (!current.previewReady || !uploadAccepted()) return 'upload_pending';
          captureFile();
          const file = selectedFile, {next} = current;
          if (!file || file.name !== 'resume.pdf' || file.size !== p.size ||
              (file.type && file.type !== 'application/pdf')) return 'attachment_unconfirmed';
          const acceptedFile = p.prior ? previewFile(current.preview) : file;
          if (!acceptedFile || acceptedFile.name !== 'resume.pdf' || acceptedFile.size !== p.size) return 'upload_pending';
          if (p.prior && current.input.files?.length === 1 && current.input.files[0] !== file) return 'attachment_unconfirmed';
          const hash = await digest(file);
          if (acceptedFile !== file && await digest(acceptedFile) !== p.hash) return 'upload_pending';
          const stillUploaded = () => {
            const checked = inspect(true);
            return sameUpload(checked) && checked.form === current.form && checked.next === next &&
              checked.input === current.input && checked.preview === current.preview &&
              checked.previewReady && (!p.prior || previewFile(checked.preview) === acceptedFile) && uploadAccepted();
          };
          if (hash !== p.hash || !stillUploaded()) {
            return 'attachment_unconfirmed';
          }
          if (next.matches(':disabled') || next.getAttribute('aria-disabled') === 'true') return 'resume_attached';
          next.scrollIntoView({block:'center',inline:'center'});
          const box = next.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          if (!next.contains(hit) || !stillUploaded() || next.matches(':disabled') || next.getAttribute('aria-disabled') === 'true') {
            return 'resume_attached';
          }
          if (!activate) return 'resume_ready_to_continue';
          // Hit-test and activate this verified node in the same browser execution.
          HTMLElement.prototype.click.call(next);
          return 'resume_continue_activated';
        },
      };
    })(''' + json.dumps(data) + ')'

def run():
    isolated = set(cdp('Target.getBrowserContexts')['browserContextIds'])
    tabs = [t for t in cdp('Target.getTargets')['targetInfos'] if t['type'] == 'page' and
            t['targetId'] == p['tabId'] and t.get('browserContextId') not in isolated]
    if len(tabs) != 1:
        return 'auth'
    switch_tab(tabs[0]['targetId'], activate=not p.get('auditOnly'))
    status = js(inspect(True))
    if status != 'ready' or p.get('auditOnly'):
        return status

    try:
        fd = os.open(p['attempt'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return 'already_started'
    attempted = False
    try:
        with os.fdopen(fd, 'w') as attempt:
            json.dump({'revision':p['revision'], 'stage':p.get('attachmentStage','resume_attachment_attempted')}, attempt)
            attempt.flush()
            os.fsync(attempt.fileno())
        stage = cdp('Runtime.evaluate', expression=inspect(False)).get('result', {})
        if not stage.get('objectId'):
            return stage.get('value', 'stage')
        node = cdp('Runtime.callFunctionOn', objectId=stage['objectId'], awaitPromise=True,
                   functionDeclaration='function () { return this.attachmentTarget(); }').get('result', {})
        if node.get('subtype') != 'node' or not node.get('objectId'):
            return 'prior_attachment_unverified' if p.get('prior') else 'stage'
        print(json.dumps({'qsJobsBrowser':'indeed_attachment_started'}), flush=True)
        attempted = True
        cdp('DOM.setFileInputFiles', objectId=node['objectId'], files=[p['path']])
        for _ in range(14):
            checked = cdp('Runtime.callFunctionOn', objectId=stage['objectId'], awaitPromise=True, returnByValue=True,
                          functionDeclaration='function () { return this.continueAfterVerification(false); }')
            status = checked.get('result', {}).get('value', 'attachment_unconfirmed')
            if status == 'resume_ready_to_continue':
                if p.get('proofMarker'):
                    fd = os.open(p['proofMarker'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, 'w') as proof:
                        json.dump({'revision':p['revision'], 'previousRevision':p['prior']['revision'],
                                   'hash':p['hash'], 'stage':'tracked_resume_verified'}, proof)
                        proof.flush()
                        os.fsync(proof.fileno())
                try:
                    fd = os.open(p['continueMarker'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    return 'resume_attached'
                with os.fdopen(fd, 'w') as attempt:
                    json.dump({'revision':p['revision'], 'stage':p.get('continueStage','resume_continue_attempted')}, attempt)
                    attempt.flush()
                    os.fsync(attempt.fileno())
                checked = cdp('Runtime.callFunctionOn', objectId=stage['objectId'], awaitPromise=True, returnByValue=True,
                              functionDeclaration='function () { return this.continueAfterVerification(true); }')
                status = checked.get('result', {}).get('value')
                if status != 'resume_continue_activated':
                    if status in ('resume_attached', 'attachment_unconfirmed', 'upload_pending'):
                        os.unlink(p['continueMarker'])
                    return 'resume_attached'
                for _ in range(12):
                    paths = [p['questionsStage'] + '/questions/1']
                    if not p.get('prior'):
                        paths.append(p['questionsStage'])
                    if js('location.origin === "https://smartapply.indeed.com" && ' + json.dumps(paths) + '.includes(location.pathname)'):
                        return 'screening_required'
                    time.sleep(.25)
                return status
            if status not in ('resume_attached', 'upload_pending'):
                return status
            time.sleep(.25)
        return 'attachment_unconfirmed' if status == 'upload_pending' else status
    finally:
        if not attempted:
            os.unlink(p['attempt'])

try:
    result = run()
except Exception:
    result = 'stage'
print(json.dumps({'qsJobsBrowser':'indeed_resume_stage','state':result}), flush=True)
`;

  async function submit(work: BrowserSubmitWork,
    options: BrowserConnection & { pdfPath: string; privateConfigPath: string }): Promise<IndeedResult> {
    const blocked = { kind: 'failed', code: 'manual_required' } as const;
    if (!matchesSource(work.sourceUrl)) return { kind: 'failed', code: 'unsupported_portal' };
    if (!matchesPosting(work) || work.kind !== 'submit') return blocked;
    const approved = claim.safeParse(work);
    if (!approved.success) return blocked;
    const uncertain = { kind: 'failed', code: 'submission_uncertain' } as const;
    // Easy Apply uses the profile email. Pause before using it for an Application Address claim.
    if (work.applicationAddress !== undefined) return await finalAttemptExists() ? uncertain : blocked;
    const [selected, finalAlreadyAttempted] = await Promise.all([readSelection(), finalAttemptExists()]);
    if (!selected) return finalAlreadyAttempted ? uncertain : { ...blocked, gate: { kind: 'authentication', url: listing } };
    const [alias, snapshot, prior] = await Promise.all([
      verifiedAlias(),
      readFile(options.privateConfigPath, 'utf8').then(raw => JSON.parse(raw) as {
        personal?: { email?: string; phone?: string; firstName?: string; lastName?: string; fullName?: string };
        answers?: Record<string, Record<string, unknown>>;
        resumeTrackingLinks?: unknown;
      }).catch(() => null),
      matchesPriorAttempt(approved.data),
    ]);
    if (!alias || typeof snapshot?.personal?.email !== 'string' || snapshot.personal.email.trim().toLowerCase() !== alias.toLowerCase()) {
      return finalAlreadyAttempted ? uncertain : { ...blocked, gate: { kind: 'authentication', url: listing } };
    }
    const answers = snapshot.answers?.[listing] ?? snapshot.answers?.[source];
    const phone = snapshot.personal.phone;
    const namePart = z.string().trim().min(1).max(80).regex(/^[^\r\n\0]+$/);
    const nameParts = z.tuple([namePart, namePart])
      .safeParse([snapshot.personal.firstName, snapshot.personal.lastName]);
    const scopedFullName = z.string().trim().min(1).max(161).regex(/^[^\r\n\0]+$/).safeParse(snapshot.personal.fullName);
    const fullName = scopedFullName.success ? scopedFullName.data : nameParts.success ? nameParts.data.join(' ') : undefined;
    const continueApplication = async (revision: number, attachmentHash?: string): Promise<IndeedResult> => {
      const result = await continueWasteSolutionsIndeed(options, selected.accountTabId, alias, phone, revision, answers, approved.data,
        fullName, nameParts.data, options.privateConfigPath, attachmentHash);
      return attachmentHash && result.kind === 'failed' ? { ...result, trackedResumeReplaced: true } : result;
    };
    if (prior && snapshot.resumeTrackingLinks === undefined) {
      if (finalAlreadyAttempted) return uncertain;
      return prior.summary === approved.data.summary ? continueApplication(prior.revision)
        : { ...blocked, indeedStage: 'tracked_resume_preview_required' };
    }
    if (prior) {
      const replaced = await verifiedPriorReplacement(approved.data, prior, options.privateConfigPath);
      if (replaced) return continueApplication(replaced.revision, replaced.hash);
      if (finalAlreadyAttempted) return uncertain;
      const attempted = await lstat(join(jobsHome(), trackedAttachmentMarker)).then(() => true,
        (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
      if (attempted) return { ...blocked, indeedStage: 'tracked_replacement_unconfirmed' };
      if (!approved.data.previewDigest) return { ...blocked, indeedStage: 'tracked_resume_preview_required' };
    }
    if (finalAlreadyAttempted) return uncertain;
    const pdf = await approvedPdf(options.pdfPath, approved.data).catch(() => undefined);
    if (!pdf) return { kind: 'failed', code: 'runner_unavailable' };
    let replacement: { revision: number; hash: string; size: number } | undefined;
    if (prior) {
      if (approved.data.previewDigest !== pdf.hash || !await verifiedTrackingPdf(pdf, options.privateConfigPath)) {
        return { ...blocked, indeedStage: 'tracked_resume_preview_required' };
      }
      const previous = await priorPdf(prior).catch(() => undefined);
      if (!previous || previous.hash === pdf.hash) return { ...blocked, indeedStage: 'prior_attachment_unverified' };
      replacement = { revision: prior.revision, hash: previous.hash, size: previous.size };
    }
    const privateInput = Buffer.from(JSON.stringify({ alias }) + '\n');
    try {
      const unconfirmed = replacement ? 'tracked_replacement_unconfirmed' : 'attachment_unconfirmed';
      const result = await withAccountBrowser<IndeedFailure>(options, {
        ...pdf, tabId: selected.accountTabId, company, role, jobKey, stage: resumeStage, fileSelector, uploadedFileSelector,
        questionsStage, revision: approved.data.revision,
        ...(replacement ? {
          prior: replacement,
          attempt: join(jobsHome(), trackedAttachmentMarker), continueMarker: join(jobsHome(), trackedContinueMarker),
          proofMarker: join(jobsHome(), trackedProofPath),
          attachmentStage: 'tracked_resume_attachment_attempted', continueStage: 'tracked_resume_continue_attempted',
        } : { attempt: join(jobsHome(), attachmentMarker), continueMarker: join(jobsHome(), resumeContinueMarker) }),
      }, { kind: 'failed', code: 'runner_unavailable' }, program, ({ exitCode, messages }) => {
        const started = z.strictObject({ qsJobsBrowser: z.literal('indeed_attachment_started') }).safeParse(messages[0]).success;
        const result = messages.length === (started ? 2 : 1) && resultMessage.safeParse(messages.at(-1));
        if (exitCode !== 0 || !result || !result.success) return started
          ? { ...blocked, indeedStage: unconfirmed } : { kind: 'failed', code: 'runner_unavailable' };
        const { state } = result.data;
        if (started && state === 'screening_required') return {
          ...blocked, indeedStage: state, attention: { questions: unansweredScreening(answers), variables: [] },
        };
        if (started) return { ...blocked, indeedStage: state === 'resume_continue_activated' || state === 'resume_attached'
          ? state : unconfirmed };
        if (state === 'auth' || state === 'challenge') return { ...blocked,
          gate: { kind: state === 'auth' ? 'authentication' : 'human_verification', url: listing } };
        if (state === 'already_started') return { ...blocked, indeedStage: unconfirmed };
        if (state === 'prior_attachment_unverified' || (replacement && state === 'stage')) return {
          ...blocked, indeedStage: 'prior_attachment_unverified',
        };
        return blocked;
      }, privateInput);
      if (replacement && result.indeedStage === 'screening_required') {
        return continueApplication(approved.data.revision, pdf.hash);
      }
      return result;
    } finally { privateInput.fill(0); }
  }

  return { discover, submit, screening };
}
