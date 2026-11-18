import { z } from "@hono/zod-openapi";

export const resumeTrack = z.enum(["engineering", "web", "admin"]).openapi("JobResumeTrack");
