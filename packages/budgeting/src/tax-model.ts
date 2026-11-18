// Tax planning data model. This is the contract the Quantself API must serve: the UI is the source of truth.
// All money is integer cents (CAD). `year` is the tax year; the page shows one year at a time.

// How sure the Owner is that a claim will be accepted. Drives the Confirmed / Likely / Uncertain groups
// and the three what-if levels (each level includes the ones before it).
export type Certainty = "confirmed" | "likely" | "uncertain";

// How a claim reduces tax:
//   deduction     — subtracted from income before tax is worked out
//   credit        — `amountCents` x creditRate comes straight off the tax
//   medicalCredit — like credit, but only the part of `amountCents` above min(floorRate x taxable income, floorCapCents) counts
export type ClaimTreatment = "deduction" | "credit" | "medicalCredit";

export type Claim = {
  id: string;
  title: string;
  certainty: Certainty;
  treatment: ClaimTreatment;
  amountCents: number;
  note: string; // what is still needed, one line ("Employer must sign a T2200S")
};

// Simplified combined federal + provincial rules for the year. The API supplies the rules.
export type TaxRules = {
  bands: { upToCents: number | null; rate: number }[]; // ascending; last band has upToCents null
  creditRate: number; // value of one dollar of credit amount (lowest federal rate + provincial rate)
  baselineCreditsCents: number; // always-applied credits: basic amounts, CPP, EI (already converted to tax, not amounts)
  medical: { floorRate: number; floorCapCents: number };
};

// A money line shown under Income or Already paid.
export type MoneyLine = { label: string; note: string; cents: number };

// A pointer to something that already exists elsewhere in the app. The UI builds the href; no data is copied.
export type AppLink =
  | { kind: "transactions"; label: string; search: string } // Transactions, filtered to this tax year and search text
  | { kind: "document"; label: string; id?: string } // Documents (drawer when id is given)
  | { kind: "subscription"; label: string; id?: string }
  | { kind: "inventoryItem"; label: string; id?: string };

// One row of the table: something the Owner needs to keep track of. A row with `claimId` follows that claim's switch.
export type TaxItem = {
  id: string;
  title: string;
  type: "Income" | "Deduction" | "Credit" | "Payment";
  amountCents: number;
  claimId?: string;
  links: AppLink[];
};

// A document still to gather before filing. `itemId` points at a TaxItem.
export type GatherDocument = {
  id: string;
  name: string;
  itemId: string;
  where: string; // where to get it
  dueDate: string; // YYYY-MM-DD
  status: "To gather" | "Requested";
};

// Last year's totals, for the "vs 2025" change on each section.
export type PriorYear = { incomeCents: number; deductionsCents: number; creditsCents: number; withheldCents: number; taxOwedCents: number };

export type TaxYearPlan = {
  year: number;
  rules: TaxRules;
  income: MoneyLine[];
  withheld: MoneyLine[]; // tax already paid, e.g. payroll withholding
  claims: Claim[];
  items: TaxItem[];
  documentsToGather: GatherDocument[];
  prior?: PriorYear;
};
