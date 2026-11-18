-- Apply only to the disposable native_interview_fixture before upgrading the pinned Jobs schema.
INSERT INTO "job_application" ("ownerId", id, "sourceKey", "sourceUrl", company, role, "resumeTrack", "updatedAt", revision, status, "lifecycleRevision")
VALUES ('native-interview-fixture-owner', 'b81f7db0-2eda-48ae-9937-f97bc1997395', 'legacy-interview-fixture', 'https://example.test/jobs/legacy',
        'Legacy', 'Tester', 'web', '2026-11-14T12:00:00', 3, 'applied', 2);

INSERT INTO "job_interview" (id, "ownerId", "applicationId", "startAt", "endAt", title, "applicationUrl", "todoNumber") VALUES
('c063028d-5cb8-478e-ae12-a8015d0938a5', 'native-interview-fixture-owner', 'b81f7db0-2eda-48ae-9937-f97bc1997395',
 '2026-11-21T14:00:00', '2026-11-21T14:30:00', 'Confirmed legacy', 'https://example.test/jobs/legacy', 42),
('df8f0ed7-d5cc-4d7f-b82b-3507c5729589', 'native-interview-fixture-owner', 'b81f7db0-2eda-48ae-9937-f97bc1997395',
 '2026-11-22T14:00:00', '2026-11-22T14:30:00', 'Pending legacy', 'https://example.test/jobs/legacy', NULL);
