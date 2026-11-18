import { candidateQuestion, referralNameField } from "../../../../../scripts/jobs/candidate-context";
import type { CandidateRulesDisplay } from "../../../../../scripts/jobs/candidate-rules";
import type { ApplicationRow } from "../jobs-client";
import type { PrivateField, FieldType } from "./private-api";

type ReusableField = { key: string; label: string; type: FieldType; options?: string[] };
export const reusableGroups: Array<{ title: string; fields: ReusableField[] }> = [
  { title: "Name and contact", fields: [
    { key: "firstName", label: "First name", type: "text" }, { key: "lastName", label: "Last name", type: "text" },
    { key: "phone", label: "Phone number", type: "phone" },
    { key: "linkedin", label: "LinkedIn profile", type: "url" }, { key: "website", label: "Website or portfolio", type: "url" },
  ] },
  { title: "Address", fields: [
    { key: "addressLine1", label: "Street address", type: "text" }, { key: "city", label: "City", type: "text" },
    { key: "region", label: "Province, state, or region", type: "text" }, { key: "postalCode", label: "Postal code", type: "text" },
    { key: "country", label: "Country of residence", type: "text" },
  ] },
  { title: "Work authorization", fields: [
    { key: "workAuthorization", label: "Work authorization details", type: "text" },
    { key: "sponsorshipRequired", label: "Do you require work sponsorship?", type: "boolean" },
  ] },
];

export const trackLabels = { engineering: "Engineering", web: "Web", admin: "Admin and Excel" } as const;

export const fieldTypeLabels: Record<FieldType, string> = {
  text: "Text", email: "Email", phone: "Phone", url: "Link", number: "Number", date: "Date", boolean: "Yes or no", option: "Choose one", options: "Choose all that apply",
};

const privateKeys = new Set(["fullName", "email", ...reusableGroups.flatMap(group => group.fields.map(field => field.key))]);
type Posting = Pick<ApplicationRow, "sourceUrl" | "company" | "role">;

export function isPrivateField(field: PrivateField, posting?: Posting, configured?: CandidateRulesDisplay) {
  if (privateKeys.has(field.key) || field.type === "email" || field.type === "phone") return true;
  if (candidateQuestion(posting, field.label, configured)) return false;
  if (referralNameField(field.label, configured)) return true;
  const label = field.label.normalize("NFKC").toLowerCase();
  return /\b(?:first name|last name|full name|surname|maiden name|legal name|preferred name|signature|sign below|e-sign|electronic sign|initials|social insurance|social security|national id|passport|driver'?s? licen[cs]e|date of birth|birthday|pronouns?|gender|race|ethnicity|disabilit\w*|accommodation|veteran|citizenship|citizen|visa|immigration|work permits?|right to work|legal(?:ly)? (?:eligible|eligibility|authorized|entitled)|work authori[sz]ation|authori[sz]ed to work|eligible to work|entitled to work|sponsor(?:ship)?|consent|certify|attest|agree|opt[ -]out|terms and conditions|acknowledg\w*|privacy|personal data|background check|criminal|conviction|reference(?:s| contact)?|referr(?:al|er) (?:name|email)|phone|mobile|e-?mail|postal|zip|street address|home address|country|current(?:ly)? (?:reside|residence|location)|linkedin)\b/.test(label);
}

export function privateFieldPresentation(field: PrivateField, configured?: CandidateRulesDisplay) {
  const referral = referralNameField(field.label, configured);
  if (referral) return {
    label: referral.title,
    help: "Enter the first and last name of the employee who referred you.",
  };
  if (field.label === "Country" && field.type === "option" &&
      configured?.phoneCountry) return {
    label: "Phone country calling code",
    help: "Use the country and code for your phone number.",
  };
  return undefined;
}
