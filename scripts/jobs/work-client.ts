import { z } from 'zod';
import {
  jobsRunnerHeartbeatInput, jobsSubmissionEventInput, jobsWorkClaimInput, jobsWorkClaimOutput,
  jobsWorkCompleteInput, jobsWorkFailInput, jobsWorkPdfHeaders, jobsWorkPdfUploadHeaders,
  jobsWorkPrivateFieldsInput, jobsWorkPrivateFieldsOutput, jobsWorkResultOutput, jobsWorkerPath,
} from '../../apps/api/src/jobs-work-contract';

export type JobsWork = NonNullable<z.infer<typeof jobsWorkClaimOutput>['work']>;
export type CodexWork = Extract<JobsWork, { kind: 'enrich' | 'tailor' | 'revise' }>;
export type RunnerWork = Extract<JobsWork, { kind: 'render' | 'submit' }>;
export type WorkFailure = z.infer<typeof jobsWorkFailInput>;
export type WorkReport = { id: string } & ({
  action: 'complete';
  kind: keyof typeof jobsWorkCompleteInput;
  body: z.infer<(typeof jobsWorkCompleteInput)[keyof typeof jobsWorkCompleteInput]>;
} | { action: 'fail'; body: WorkFailure });

export class JobsWorkTransportError extends Error {
  constructor(readonly status?: number) {
    super(status === undefined ? 'jobs_work_api_unavailable' : `jobs_work_api_${status}`);
  }
}

export function verifiedPdf(pdf: Uint8Array) {
  if (pdf.byteLength < 5 || pdf.byteLength > maxPdfBytes || Buffer.from(pdf.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new Error('invalid_job_pdf');
  }
  return pdf;
}

const maxPdfBytes = 16 * 1024 * 1024;
const pdfPath = (work: RunnerWork) => `/applications/${work.applicationId}/revisions/${work.revision}/pdf`;
const leaseHeaders = (work: RunnerWork) =>
  jobsWorkPdfHeaders.parse({ 'x-job-work-id': work.id, 'x-job-lease-token': work.leaseToken });

export function createJobsWorkClient({ baseUrl, secret, fetchImpl = fetch }: {
  baseUrl: string; secret: string; fetchImpl?: typeof fetch;
}) {
  const url = new URL(baseUrl);
  if (!secret.trim() || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && (url.protocol !== 'http:' || !['api', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('invalid_jobs_work_connection');
  }

  async function request(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${secret}`);
    let response: Response;
    const options: RequestInit & { cache: 'no-store' } = {
      ...init, headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
    };
    try {
      response = await fetchImpl(new URL(jobsWorkerPath + path, url), options);
    } catch {
      throw new JobsWorkTransportError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new JobsWorkTransportError(response.status);
    }
    return response;
  }

  const post = (path: string, body: unknown) =>
    request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function accepted(response: Response) {
    jobsWorkResultOutput.parse(await response.json());
  }
  return {
    async claim(input: z.input<typeof jobsWorkClaimInput>) {
      const response = await post('/work/claim', jobsWorkClaimInput.parse(input));
      return jobsWorkClaimOutput.parse(await response.json()).work;
    },
    async report(report: WorkReport) {
      const id = z.uuid().parse(report.id);
      const body = report.action === 'fail' ? jobsWorkFailInput.parse(report.body) : jobsWorkCompleteInput[report.kind].parse(report.body);
      await accepted(await post(`/work/${id}/${report.action}`, body));
    },
    async privateFields(work: RunnerWork) {
      const response = await post(`/work/${work.id}/private-fields`, jobsWorkPrivateFieldsInput.parse({ leaseToken: work.leaseToken }));
      return jobsWorkPrivateFieldsOutput.parse(await response.json());
    },
    async heartbeat(host: string) {
      await accepted(await post('/runner/heartbeat', jobsRunnerHeartbeatInput.parse({ host })));
    },
    async submissionEvent(applicationId: string, event: z.input<typeof jobsSubmissionEventInput>) {
      await accepted(await post(`/submissions/${z.uuid().parse(applicationId)}/events`, jobsSubmissionEventInput.parse(event)));
    },
    async uploadPdf(work: Extract<RunnerWork, { kind: 'render' }>, pdf: Uint8Array, sha256: string) {
      const headers = jobsWorkPdfUploadHeaders.parse({ ...leaseHeaders(work), 'x-content-sha256': sha256 });
      const response = await request(pdfPath(work), {
        method: 'PUT', headers: { 'Content-Type': 'application/pdf', ...headers }, body: Buffer.from(verifiedPdf(pdf)),
      });
      await response.body?.cancel();
    },
    async downloadPdf(work: Extract<RunnerWork, { kind: 'submit' }>) {
      const response = await request(pdfPath(work), { method: 'GET', headers: leaseHeaders(work) });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('invalid_job_pdf');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maxPdfBytes) throw new Error('invalid_job_pdf');
          chunks.push(chunk.value);
        }
        return verifiedPdf(Buffer.concat(chunks, length));
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

export type JobsWorkClient = ReturnType<typeof createJobsWorkClient>;
