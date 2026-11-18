import { redirect } from "next/navigation";

// The Jobs area opens on Overview.
export default function JobsPage() {
  redirect("/jobs/overview");
}
