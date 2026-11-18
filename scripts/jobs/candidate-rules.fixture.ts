import type { CandidateRule, CandidateRules } from './candidate-rules';

export const screeningPosting = {
  sourceUrl: 'https://job-boards.greenhouse.io/example-research/jobs/42',
  company: 'Example Research',
  role: 'Research Coordinator',
};
export const experiencePosting = {
  sourceUrl: 'https://board.example.test/jobs/43',
  company: 'Example Billing',
  role: 'Billing Clerk',
};
const noticeHelp = 'Use the exact supported notice interval.';
const referralLabel = 'Were you referred by an employee?';
const referralName = 'If yes, enter their name.';
const noticeLabels = ['What is your notice period if successful?', 'What is your notice period?'];
const screeningRules: CandidateRule[] = [
  { id: 'question_1001', label: 'How many years of clinical research experience do you have?',
    type: 'text', key: 'screening-clinical-research-years', title: 'Years of clinical research experience', resumeOnlyValue: '0', format: 'count' },
  { id: 'question_1002', label: 'Which clinical research settings have you worked in?',
    type: 'textarea', key: 'screening-clinical-research-environment', title: 'Clinical research setting', resumeOnlyValue: 'No clinical research experience' },
  { id: 'question_1003', label: 'Have you created Source documentation before?', type: 'combobox',
    key: 'screening-created-source-documentation', title: 'Have you created original clinical-study records?',
    help: 'For example, records that first capture study observations or measurements.', resumeOnlyValue: 'No', format: 'yes-no' },
  { id: 'question_1004', label: 'How many studies have you coordinated simultaneously', type: 'text',
    key: 'screening-concurrent-clinical-studies', title: 'Most clinical studies coordinated at once', resumeOnlyValue: '0', format: 'integer' },
  { id: 'question_1005', label: 'What is your expected monthly salary in USD?',
    type: 'textarea', key: 'screening-monthly-salary-usd', title: 'Expected monthly salary in USD', help: 'Enter the monthly amount in USD.',
    format: 'salary' },
  ...noticeLabels.map((label, index) => ({
    id: index === 0 ? 'question_1006' : 'question_1007', label, type: 'combobox' as const,
    key: 'screening-notice-period', title: 'Notice period', help: noticeHelp, format: 'notice' as const,
  })),
  { id: 'question_1008', label: referralLabel, type: 'textarea', key: 'screening-referred',
    title: 'Were you referred by a Example Research employee?', format: 'yes-no' },
  { id: 'question_1010', label: 'Do you speak English fluently?', type: 'combobox',
    key: 'english-fluent', title: 'Do you speak English fluently?', format: 'yes-no' },
];
const listingRules: CandidateRule[] = [
  { id: 'indeed-relevant-experience', label: 'How many years of relevant work experience do you have in a similar role?',
    type: 'text', key: 'listing-similar-role-years', title: 'Years of relevant experience',
    help: 'Enter the years your résumé supports. Use 0 if none of your roles were similar.', format: 'count' },
];

export const candidateRules: CandidateRules = [
  { ...screeningPosting, rules: screeningRules, phoneCountry: true, referral: {
    question: { id: 'question_1008', label: referralLabel, type: 'textarea' },
    name: { id: 'question_1009', label: referralName, type: 'textarea' },
    title: 'Referring employee’s full name',
  } },
  { ...experiencePosting, rules: listingRules, residence: {
    country: 'Canada',
    field: { id: 'indeed-current-residence', label: 'Do you currently reside in Canada?', type: 'select' },
  } },
];
