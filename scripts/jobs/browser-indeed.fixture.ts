import { createHash } from 'node:crypto';

// Synthetic posting and local application identity for adapter parity tests.
export const indeedFixture = {
  "source": "https://careers.example.test/jobs/fixture-opening",
  "jobKey": "00000000f0000001",
  "listing": "https://ca.indeed.com/viewjob?jk=00000000f0000001",
  "applicationId": "00000000-0000-4000-8000-000000009001",
  "company": "Example Employer",
  "role": "Fixture Associate",
  "selectionPath": "fixture-indeed-selection.json",
  "resumeStage": "/beta/indeedapply/form/resume-selection-module/resume-selection",
  "fileSelector": "input[type=file][data-testid=resume-selection-file-resume-upload-radio-card-file-input]",
  "uploadedFileSelector": "input[type=file][data-testid=resume-selection-file-resume-radio-card-file-input]",
  "questionsStage": "/beta/indeedapply/form/questions-module",
  "reviewStage": "/beta/indeedapply/form/review-module",
  "finalDisclosure": "Selecting Submit sends this synthetic application and accepts the Terms, Cookie & Privacy Policies.",
  "attestationStatement": "I confirm the synthetic application is complete.",
  "attestationFields": [
    {
      "name": "q_00000000000000000000000000000064",
      "type": "MULTISELECT",
      "label": "I confirm the synthetic application is complete.",
      "options": [
        [
          "Yes, I agree to sign electronically.",
          "attestationSign"
        ]
      ]
    },
    {
      "name": "q_00000000000000000000000000000065",
      "type": "TEXT",
      "label": "Synthetic attestation 2",
      "options": []
    },
    {
      "name": "q_00000000000000000000000000000066",
      "type": "SELECT",
      "label": "Synthetic attestation 3",
      "options": [
        [
          "No",
          "N"
        ],
        [
          "Yes",
          "Y"
        ]
      ]
    }
  ],
  "screeningControlNames": ["q_00000000000000000000000000000067", "q_00000000000000000000000000000068", "q_00000000000000000000000000000069"],
  "screeningFields": [
    {
      "id": "indeed-work-authorization",
      "label": "Synthetic screening question 1",
      "type": "select",
      "required": true,
      "options": [
        "Yes",
        "No"
      ]
    },
    {
      "id": "indeed-current-residence",
      "label": "Synthetic screening question 2",
      "type": "select",
      "required": true,
      "options": [
        "Yes",
        "No"
      ]
    },
    {
      "id": "indeed-relevant-experience",
      "label": "Synthetic screening question 3",
      "type": "text",
      "required": true,
      "options": []
    }
  ],
  "location": "London, ON",
  "resumeTrack": "admin"
};

export const fixtureFinalDisclosureDigest = createHash('sha256').update(indeedFixture.finalDisclosure).digest('hex');
export const fixtureAttestationStatementDigest = createHash('sha256').update(indeedFixture.attestationStatement).digest('hex');
