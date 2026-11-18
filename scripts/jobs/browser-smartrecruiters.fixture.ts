const origin = 'https://jobs.smartrecruiters.com';
const team = 'ExampleStudio';
const role = 'Example Web Coordinator';

export const smartRecruitersFixture = {
  sourceUrl: `${origin}/${team}/12345678-example-web-coordinator`,
  url: `${origin}/oneclick-ui/company/${team}/publication/00000000-0000-4000-8000-000000000001?dcr_ci=${team}`,
  company: 'Example Studio',
  role,
  listingTitle: `Example Studio ${role} | SmartRecruiters`,
  applicationTitle: `Easy apply - ${role} - Example Studio`,
};
