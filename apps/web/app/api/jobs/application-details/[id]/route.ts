import { candidateRulesDisplay } from "../../../../../../../scripts/jobs/candidate-rules";
import { readCandidateRules } from "../../../../../../../scripts/jobs/local-candidate-rules";
import type { components } from "@/lib/generated/quantself-api-schema";
import type { ApplicationDetails } from "../../../../jobs/private/private-api";

type JobApplication = components["schemas"]["JobReviewApplicationDetail"];

const headers = { "Cache-Control": "private, no-store" };
const applicationId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!applicationId.test(id)) return new Response(null, { status: 400, headers });
  const authorization = new Headers({ accept: "application/json" });
  // The API checks Owner access and application scope before any private mapping is read.
  for (const name of ["cookie", "origin", "x-quantself-owner-proof"]) {
    const value = request.headers.get(name);
    if (value !== null) authorization.set(name, value);
  }
  try {
    const url = new URL(`/api/v1/jobs/applications/${id}`, process.env.QUANTSELF_API_INTERNAL_URL ?? "http://api:3001");
    const response = await fetch(url, {
      headers: authorization, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) return new Response(null, { status: response.status, headers });
    const { application } = await response.json() as { application: JobApplication };
    if (application?.id.toLowerCase() !== id.toLowerCase()) return new Response(null, { status: 502, headers });
    const { company, role, sourceUrl, status, track: resumeTrack, issue: issueCode, approvedRevision, privatePauseFieldKeys } = application;
    const selection: ApplicationDetails["application"] = { company, role, sourceUrl, status, resumeTrack, issueCode, approvedRevision, privatePauseFieldKeys };
    try {
      const candidateRules = candidateRulesDisplay(selection, readCandidateRules());
      return Response.json({ application: selection, candidateRules }, { headers });
    } catch {
      return Response.json({ application: selection, candidateRulesUnavailable: true }, { headers });
    }
  } catch {
    return new Response(null, { status: 502, headers });
  }
}
