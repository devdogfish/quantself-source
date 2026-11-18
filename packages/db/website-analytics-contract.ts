export const analyticsSite = "girke.dev";
export const analyticsRetentionMs = 90 * 24 * 60 * 60 * 1000;
export const analyticsCohorts = ["default", "client", "software", "web-cms", "admin-excel"] as const;
export const analyticsSources = [
  "direct", "unknown", "linkedin", "github", "email", "search", "referral",
  "job-board", "social", "other", "synthetic",
  "resume-software", "resume-web-cms", "resume-admin-excel", "kristina-footer",
] as const;
export const analyticsCtas = [
  "navigation",
  "resume", "repository", "demo", "live-site", "workbook", "contact",
  "email", "booking", "project", "linkedin", "github", "download",
  "resume_download", "repository_open", "demo_open", "project_open",
  "contact_open", "email_click", "booking_click",
] as const;
