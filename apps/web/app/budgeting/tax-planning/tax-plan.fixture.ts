import type { TaxYearPlan } from "./tax-model";

// Original demo plan for refund and page parity tests.
export const sampleTaxPlan: TaxYearPlan = {
  year: 2026,
  rules: {
    bands: [{ upToCents: 3_050_700, rate: 0.2279 }, { upToCents: 5_852_300, rate: 0.2895 }, { upToCents: null, rate: 0.33 }],
    creditRate: 0.2279,
    baselineCreditsCents: 410_000,
    medical: { floorRate: 0.03, floorCapCents: 289_000 },
  },
  income: [
    { label: "Co-op employment (T4)", note: "19 payroll deposits", cents: 3_840_000 },
    { label: "Freelance invoice, Berlin client", note: "€3,200 at the Bank of Canada rate", cents: 486_200 },
  ],
  withheld: [{ label: "Income tax withheld", note: "Sent to the CRA from your paycheques", cents: 512_000 }],
  claims: [
    { id: "software", title: "Software & hosting", certainty: "confirmed", treatment: "deduction", amountCents: 61_800, note: "12 transactions logged" },
    { id: "tuition", title: "Tuition", certainty: "confirmed", treatment: "credit", amountCents: 712_400, note: "T2202 slip arrives in February" },
    { id: "dental", title: "Dental & orthodontics", certainty: "confirmed", treatment: "medicalCredit", amountCents: 214_000, note: "Only the part above 3% of income counts" },
    { id: "server", title: "Server hardware", certainty: "likely", treatment: "deduction", amountCents: 240_000, note: "Need the date it went into use" },
    { id: "workspace", title: "Home workspace", certainty: "uncertain", treatment: "deduction", amountCents: 210_000, note: "Employer must sign a T2200S" },
    { id: "phone", title: "Phone & internet", certainty: "uncertain", treatment: "deduction", amountCents: 36_000, note: "Need a business-use log" },
  ],
  items: [
    { id: "t4", title: "Co-op employment (T4)", type: "Income", amountCents: 3_840_000, links: [{ kind: "transactions", label: "19 payroll deposits", search: "payroll" }] },
    { id: "freelance", title: "Freelance invoice, Berlin client", type: "Income", amountCents: 486_200, links: [{ kind: "document", label: "Invoice INV-0042" }, { kind: "transactions", label: "Wise deposit", search: "wise" }] },
    { id: "withheld", title: "Income tax withheld", type: "Payment", amountCents: 512_000, links: [{ kind: "transactions", label: "From payroll", search: "payroll" }] },
    { id: "software", title: "Software & hosting", type: "Deduction", amountCents: 61_800, claimId: "software", links: [{ kind: "transactions", label: "12 transactions", search: "hosting" }, { kind: "subscription", label: "Hosting plans" }] },
    { id: "server", title: "Server hardware", type: "Deduction", amountCents: 240_000, claimId: "server", links: [{ kind: "inventoryItem", label: "Server in Inventory" }, { kind: "document", label: "Newegg receipt" }] },
    { id: "workspace", title: "Home workspace", type: "Deduction", amountCents: 210_000, claimId: "workspace", links: [{ kind: "subscription", label: "Rent" }, { kind: "document", label: "Lease" }] },
    { id: "phone", title: "Phone & internet, business share", type: "Deduction", amountCents: 36_000, claimId: "phone", links: [{ kind: "subscription", label: "Phone & internet" }] },
    { id: "tuition", title: "Tuition, Dalhousie", type: "Credit", amountCents: 712_400, claimId: "tuition", links: [{ kind: "transactions", label: "Tuition payments", search: "dalhousie" }] },
    { id: "dental", title: "Dental & orthodontics", type: "Credit", amountCents: 214_000, claimId: "dental", links: [{ kind: "document", label: "3 receipts" }, { kind: "document", label: "Insurance statement" }, { kind: "transactions", label: "Payments", search: "dental" }] },
  ],
  documentsToGather: [
    { id: "g1", name: "Final 2026 pay stub (T4 boxes 14, 22)", itemId: "t4", where: "Employer payroll portal", dueDate: "2026-12-31", status: "To gather" },
    { id: "g2", name: "T4 slip", itemId: "t4", where: "Employer or CRA My Account", dueDate: "2027-02-28", status: "To gather" },
    { id: "g3", name: "T2200S, employer-signed", itemId: "workspace", where: "Ask your employer", dueDate: "2027-02-28", status: "Requested" },
    { id: "g4", name: "T2202 tuition slip", itemId: "tuition", where: "Dalhousie student portal", dueDate: "2027-02-28", status: "To gather" },
    { id: "g5", name: "Date the server went into use", itemId: "server", where: "Your own records", dueDate: "2027-03-31", status: "To gather" },
    { id: "g6", name: "Business-use log for phone & internet", itemId: "phone", where: "Your own records", dueDate: "2027-03-31", status: "To gather" },
  ],
  prior: { incomeCents: 3_980_000, deductionsCents: 180_000, creditsCents: 520_000, withheldCents: 470_000, taxOwedCents: 357_100 },
};
