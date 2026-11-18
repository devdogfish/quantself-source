-- Lane is derived from the actual job and named employer as well as its résumé.
-- Preserve application revisions, source snapshots and approval provenance.
UPDATE "job_application"
SET "reviewLane" = CASE
  WHEN "resumeTrack" = 'engineering'
    OR "company" ~* '^[[:space:]]*(deloitte|rbc|royal[[:space:]]*bank|bell|nova[[:space:]]+scotia[[:space:]]+power|ibm)($|[[:space:],./(&-])'
    OR "role" ~* '\m((software([[:space:]]+development)?|web|systems?|platform|cloud|devops|data([[:space:]]+(migration|platform))?|machine[[:space:]]+learning|site[[:space:]]+reliability|front[- ]?end|back[- ]?end|full[- ]?stack|network|security|qa|quality[[:space:]]+assurance|application|solutions)[[:space:]]+(engineering|engineer|developer|architect)|engineering[[:space:]]+(manager|lead|director)|technical[[:space:]]+architect)\M'
  THEN 'tailored'::"JobReviewLane"
  ELSE 'quick'::"JobReviewLane"
END;
