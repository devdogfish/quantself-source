// Synthetic direct browser route and form profiles for offline parity tests.
export const directBrowserFixtures = [
  {
    "portal": "greenhouse",
    "sources": [
      "https://embedded.example.test/job?gh_jid=1000105"
    ],
    "company": "Embedded Board",
    "role": "Fixture Billing Associate",
    "url": "https://job-boards.greenhouse.io/embed/job_app?for=fixture-embedded&token=1000105&b=https%3A%2F%2Fwww.embedded.example.test%2Fjob%2F%3Ffrom%3Dfixture",
    "listingUrl": "https://embedded.example.test/job?gh_jid=1000105",
    "listingPath": "/embed/job_app",
    "sourceTitle": "Fixture Billing Associate | Embedded Board Careers",
    "applicationTitle": "Job Application for Fixture Billing Associate at Embedded Board"
  },
  {
    "portal": "manatal",
    "sources": [
      "https://www.careers-page.com/fixture-office/job/FA000001",
      "https://www.careers-page.com/fixture-office/job/FA000001/apply"
    ],
    "company": "Example Office",
    "role": "Fixture Accounts Associate",
    "url": "https://www.careers-page.com/fixture-office/job/FA000001/apply",
    "listingUrl": "https://www.careers-page.com/fixture-office/job/FA000001",
    "listingPath": "/fixture-office/job/FA000001",
    "form": {
      "selector": "form:has(> .form-group input.custom-file-input):has(button#submit-id-submit)",
      "resumeSelector": "input#field910002[type=file]",
      "fields": {
        "input#field900002[name=\"900002\"]": "fullName",
        "input#field900004[name=\"900004\"]": "email",
        "input#field900006[name=\"900006\"]": "phone"
      }
    },
    "termsControl": "input[type=checkbox][name=terms_and_condition]",
    "termsLabel": "I agree to the terms and conditions & privacy policy",
    "termsPath": "/fixture-office/terms-and-conditions",
    "privacyPath": "/fixture-office/privacy-policy"
  },
  {
    "portal": "workable",
    "sources": [
      "https://apply.workable.com/fixture-studio/j/FIXTURE001",
      "https://apply.workable.com/fixture-studio/j/FIXTURE001/apply/"
    ],
    "company": "Example Studio",
    "role": "Fixture Support Associate",
    "url": "https://apply.workable.com/fixture-studio/j/FIXTURE001/apply/",
    "listingUrl": "https://apply.workable.com/fixture-studio/j/FIXTURE001",
    "listingPath": "/fixture-studio/j/FIXTURE001",
    "radioNames": [
      "QA_700001",
      "QA_700002"
    ]
  },
  {
    "portal": "rippling",
    "sources": [
      "https://board.example.test/jobs/fixture-migration-opening",
      "https://ats.rippling.com/fixture-organization/jobs/00000000-0000-4000-8000-000000000107"
    ],
    "company": "Example Data",
    "role": "Fixture Migration Engineer",
    "url": "https://ats.rippling.com/fixture-organization/jobs/00000000-0000-4000-8000-000000000107/apply?jobBoardSlug=fixture-organization&jobId=00000000-0000-4000-8000-000000000107&step=application",
    "listingUrl": "https://ats.rippling.com/fixture-organization/jobs/00000000-0000-4000-8000-000000000107",
    "listingPath": "/fixture-organization/jobs/00000000-0000-4000-8000-000000000107",
    "sourceListing": "https://board.example.test/jobs/fixture-migration-opening",
    "sourceHeading": "Fixture Migration Engineer",
    "sourceLinkHref": "/fixture-organization",
    "sourceLinkLabel": "Example Data",
    "listingTitle": "Fixture Migration Engineer",
    "listingHeading": "Fixture Migration Engineer",
    "applicationTitle": "apply - Fixture Migration Engineer",
    "receiptHeading": "You have successfully applied to Fixture Migration Engineer",
    "applicationHeading": "application: Fixture Migration Engineer"
  },
  {
    "portal": "branded",
    "sources": [
      "https://application.example.test/careers/job/fixture-opening",
      "https://application.example.test/emplois/poste-fictif"
    ],
    "company": "Example Services",
    "role": "Fixture Service Associate",
    "url": "https://application.example.test/careers/job/fixture-opening",
    "listingUrl": "https://application.example.test/careers/job/fixture-opening",
    "listingPath": "/careers/job/fixture-opening",
    "sourceListing": "https://application.example.test/emplois/poste-fictif",
    "pageTitle": "Fixture Service Associate | Example Services",
    "headingSelector": "main#fixture-main h1",
    "verificationSelector": "[aria-label=\"Fixture verification\"]",
    "verificationResponse": "input[type=hidden][name=fixture-verification-response]",
    "receipt": {"rootSelector": "main#fixture-main section#fixture-apply", "heading": "Fixture receipt", "prefix": "Receipt number: ", "suffix": ". Your fixture is complete."},
    "form": {
      "selector": "main#fixture-main section#fixture-apply form[novalidate]",
      "resumeSelector": "input#fixture-resume[type=file]",
      "fields": {
        "input[name=firstName][type=text]": "firstName",
        "input[name=lastName][type=text]": "lastName",
        "input[name=email][type=email]": "email",
        "input[name=phone][type=tel]": "phone",
        "input[name=city][type=text]": "city",
        "select[name=province]": "region"
      }
    },
    "requiredControls": [
      [
        "select[name=province]",
        "Province"
      ],
      [
        "select[name=workAuthorization]",
        "Work authorization in Canada"
      ],
      [
        "select[name=yearsExperience]",
        "Years of experience"
      ],
      [
        "select[name=englishLevel]",
        "English level"
      ],
      [
        "select[name=frenchLevel]",
        "French level"
      ],
      [
        "select[name=workModePreference]",
        "Preferred work mode"
      ],
      [
        "input[name=consent][type=checkbox][value=true]",
        "I permit Example Services to review this fixture application."
      ]
    ],
    "optionalControl": [
      "input[name=talentOptIn][type=checkbox][value=true]",
      "Keep this example application in the fixture talent pool."
    ]
  },
  {
    "portal": "jazzhr",
    "sources": [
      "https://example-catalog.applytojob.com/apply/FixtureOpening01"
    ],
    "company": "Example Catalog",
    "role": "Fixture Catalog Associate",
    "url": "https://example-catalog.applytojob.com/apply/FixtureOpening01",
    "listingUrl": "https://example-catalog.applytojob.com/apply/FixtureOpening01",
    "listingPath": "/apply/FixtureOpening01"
  },
  {
    "portal": "taleo",
    "sources": [
      "https://contact.example.test/en/job/fixture-opening"
    ],
    "company": "Example Contact",
    "role": "Fixture Contact Associate",
    "url": "https://example-contact.taleo.net/careersection/99/jobapply.ftl?job=FX001",
    "listingUrl": "https://contact.example.test/en/job/fixture-opening",
    "listingPath": "/careersection/99/jobapply.ftl",
    "sourceApply": "https://example-contact.taleo.net/careersection/17/jobapply.ftl?job=FX001",
    "sourceTitle": "Fixture Contact Associate Job in Montreal at Example Contact",
    "applicationTitle": "Privacy Agreement",
    "applicationHeading": "Privacy Agreement",
    "policyUrl": "https://contact.example.test/privacy",
    "agreementPath": "/careersection/fixture/statement.jsf",
    "policyNotice": "Example Contact's Website Privacy Policy"
  }
];
