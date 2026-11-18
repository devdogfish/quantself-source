import type { readEmailRoutes } from './email-routes';

export const applicationQuestions = [
  'How have you worked remotely?',
  'How do you organize your work?',
  'What interests you about this role?',
];

export const questionEmailPosting = {
  sourceUrl: 'https://creative.example.test/jobs/content',
  company: 'Example Creative',
  role: 'Freelance Content Coordinator',
};

export const resumeEmailPosting = {
  sourceUrl: 'https://listings.example.test/jobs?posting_id=1234',
  company: 'Example Services',
  role: 'Accounts Payable Clerk',
};

export const emailRoutes = [
  {
    ...questionEmailPosting,
    sourceUrls: [questionEmailPosting.sourceUrl, questionEmailPosting.sourceUrl + '/'],
    recipient: 'jobs@creative.example.test',
    subjectNamePrefix: 'Content Coordinator',
    questions: applicationQuestions,
  },
  {
    ...resumeEmailPosting,
    sourceUrls: [resumeEmailPosting.sourceUrl],
    recipient: 'apply@services.example.test',
    questions: [],
  },
].map(({ sourceUrl, ...route }) => route) satisfies ReturnType<typeof readEmailRoutes>;
