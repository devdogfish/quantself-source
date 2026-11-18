import { expect, test } from "bun:test";
import { describeResumeLinks, extractResumeLinks, resumeLinkCatalog } from "./resume-links";

test("describes retained projects, recognizes tracked aliases, and omits contact links", () => {
  const portfolio = "https://girke.dev/go/admin-excel/profile/portfolio/external";
  const linkedIn = "https://girke.dev/go/admin-excel/profile/linkedin/external";
  const rbc = "https://girke.dev/go/admin-excel/project/rbc-analytics/demo";
  const sms = "https://girke.dev/go/software/project/etpzp-sms/repository";
  const replacements = {
    "https://luigigirke.com": portfolio,
    "https://www.linkedin.com/in/luigigirke": linkedIn,
    "https://rbc-analytics.demo.girke.dev": rbc,
    "https://github.com/devdogfish/etpzp-sms": sms,
  };
  const header = `[Site](${portfolio}) [Profile](${linkedIn}) [Email](mailto:private@example.test)`;
  const catalog = resumeLinkCatalog(header, replacements);
  const document = `# {{fullName}}\n\n{{contact}}\n\n## Summary\n[Demo](${rbc}) and [Source](${sms}) [Profile](${linkedIn})`;
  expect(describeResumeLinks(document, catalog)).toBe("This résumé links to the project portfolio website, the RBC analytics demo, and the ETPZP SMS project source code.");
  expect(describeResumeLinks(document.replace(`[Source](${sms})`, ""), catalog)).toBe("This résumé links to the project portfolio website and the RBC analytics demo.");
  expect(JSON.stringify(catalog)).not.toContain("private@example.test");
});

test("live edits describe added public links and exclude LinkedIn in application tracking URLs", () => {
  const app = "https://girke.dev/r/" + "a".repeat(24);
  const source = `[Demo](${app}/project/rbc/demo) [LinkedIn](${app}/profile/linkedin) [New reporting tool](https://example.test/report)`;
  expect(describeResumeLinks(source)).toBe("This résumé links to the RBC analytics demo and New reporting tool.");
  expect(describeResumeLinks("[Email](mailto:owner@example.test) [LinkedIn](https://www.linkedin.com/in/synthetic)")).toBe("This résumé has no additional project links.");
  expect(extractResumeLinks("[Incomplete](https://example.test")).toEqual([]);
  expect(extractResumeLinks("[A](https://example.test/project_(x))")).toEqual([{ url: "https://example.test/project_(x)", label: "A" }]);
  expect(extractResumeLinks("\\[Escaped](https://example.test) `[Code](https://example.test)`")).toEqual([]);
});
