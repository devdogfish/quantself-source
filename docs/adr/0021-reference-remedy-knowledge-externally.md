# Reference Remedy Knowledge Externally

Each owned remedy is an ordinary Inventory Product with a minimal Remedy Profile containing its owned potencies, short local selection summary, and source-qualified External Knowledge References. Remedy Registration is API-first: a research-capable AI Client performs research and submits immediately search-visible facts, while Quantself performs no remedy web research or later background enrichment for these fields. The authorized registration call is the approval event, and provenance identifies the submitting client and sources.

OOREP is the initial external homeopathic knowledge system. AI Clients query it through the OOREP MCP/SDK for repertory and materia-medica research, then store only the remedy abbreviation or identifier and source URL in Quantself. Quantself does not mirror OOREP text. Provings.info is the designated backup source for a future remedy upgrade because it provides extensive remedy, proving, taxonomy, and literature references; its links may be stored now, but no automated integration is included initially.

Ralph recommended these additional future sources. Globuli.de's [Aconitum napellus reference](https://www.globuli.de/einzelmittel/globuli-von-a-bis-a/aconitum-napellus/) is a remedy-specific source. [H. Zeeden publications](https://www.h-zeeden.de/Publikationen/) is a general publication source. They may be evaluated for future owned-remedy matching and recommendation work; no automated integration or imported content is authorized by this decision.

Licensed modern repertories such as Synthesis and Complete Repertory are deferred until an authorized integration exists. Mainstream drug-label databases are not remedy-selection sources.

Quantself does not add a separate Remedy entity, potency variant model, or copied remedy database; clients shortlist owned products locally and fetch detailed external knowledge on demand. Per-potency quantities are intentionally not tracked.

The Remedies page is not a recommendation surface. Its primary UI is a full-screen timeline summarizing remedy intake by remedy and potency, with range controls and totals, followed by a minimal intake form and the owned-remedy library. Remedy intake reuses the shared Substance and Substance Intake models: registration automatically creates and links a hidden HOMEOPATHY Substance, so the owner maintains no duplicate remedy record. Intake does not decrement Inventory quantity.
