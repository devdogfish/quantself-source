# Memory is split into four layers

Status: accepted, 2026-11-11. Retrieval decision updated 2026-11-14.

Each kind of memory has one home:

| Layer | Holds | Shared | Home |
| --- | --- | --- | --- |
| Second brain | Owner knowledge, notes, sources, agent-maintained wiki | One, owned by the Owner | Git-backed Markdown repository (`brain`), opened as an Obsidian vault |
| Memory of the Owner | Preferences, reactions, working style learned from interactions | One; every Agent contributes | Self-hosted Honcho, one Owner peer |
| Agent memory | Personality, skills, lessons and Owner corrections for one role | Per Agent | Hermes `SOUL.md`, memory files and skills, plus the Agent's Honcho peer |
| Live state | The Owner's tasks, Job Applications, Calendar | One | Quantself API |
| Agent work | Each Agent's own tasks and conversations with the Owner | Per Agent | The Agent's Hermes home and Bot HQ (ADR 0046) |

Facts about the world or the Owner go to shared layers. Know-how for one role stays with the Agent. An Agent proposes generally useful lessons for the brain through the inbox.

Live data never enters the brain. Job Applications, for example, stay in Quantself, so knowledge and state cannot diverge. Secrets and encrypted fields (application answers, finances, health and relationships) never enter Honcho or the brain. They live in Quantself behind scoped keys or in a separate Private Brain repository that is never cloned onto Agent machines. Honcho's per-Agent separation is weak, so hard isolation uses separate workspaces or repositories.

The brain is separate from the Owner's existing Obsidian vaults, which Agents do not access. It follows the layered "LLM wiki" pattern:

- `raw/` holds immutable sources, such as YouTube transcripts and articles.
- `wiki/` holds pages that Agents maintain, every claim cited to a source.
- `notes/` holds the Owner's own notes. Agents read these and only append suggestions.
- Supporting folders: `inbox/`, `journal/`, `efforts/`, `areas/` hubs, `records/` (Johnny Decimal), `_meta/` and `log/`.

The brain's rules:

- Folders encode note type and lifecycle, never topic.
- Keep Obsidian Bases as Owner dashboards for YAML properties such as topic and status. Agent retrieval uses Markdown files.
- New wiki pages and raw source notes carry a one-line YAML `summary` and optional `aliases`. The generated index shows these fields beside each path.
- Agents create and append but never rename, move or delete.
- Agent lint uses scoped file and Git checks and reports findings for Owner review.
- Large media stays out of git.
- Agents use the latest `_meta/index.md` snapshot and topic map to orient, then search shared paths with `rg` or Hermes `search_files`. Open relevant wiki pages and follow their links to raw evidence. Search raw sources directly when the wiki has a gap.
- Use local qmd hybrid search as a fallback after direct search and link following leave an evidence gap. Scope its index to shared paths and verify hits against Markdown sources. If misses recur, replay real questions to check citation accuracy and latency before expanding qmd use.

On the synthetic fixture used to tune summary-guided `rg`, it found all evidence after link traversal on 40 of 40 answerable questions, with a 7 ms median search. qmd hybrid found it on 39 of 40 at 2.78 s and had higher first-pass paraphrase recall. [Benchmark #273](https://github.com/devdogfish/quantself/issues/273)
