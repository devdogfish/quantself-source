import { redirect } from "next/navigation";

// Candidate context lives on Profile.
export default function JobsCandidateContextPage() {
  redirect("/jobs/profile");
}
