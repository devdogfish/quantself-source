import { redirect } from "next/navigation";

// Shared answers live on Profile; answers for one application are given in Submissions when the runner asks.
export default function JobsPrivatePage() {
  redirect("/jobs/profile");
}
