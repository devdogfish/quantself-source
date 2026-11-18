# Shared brain retrieval and Obsidian Bases

Researched 2026-11-14 for [#273](https://github.com/devdogfish/quantself/issues/273). Follows [ADR 0042](../adr/0042-memory-layers.md) and [#194](https://github.com/devdogfish/quantself/issues/194). Brain checked at `brain` commit `4e825aa` ("Record initial brain lint"). The brain's own literature note, `_meta/retrieval-research.md`, is untracked in that checkout. Tool versions: Hermes v0.23.1 (commit `3b42157`), qmd v2.8.3, Obsidian help as of today. Nothing was installed or benchmarked. Statements about behavior come from docs and source code. Items marked UNVERIFIED have no primary source.

## Findings that change the plan

1. **The brain has no content to evaluate yet.** Commit `4e825aa` has 7 area hubs, the Career job criteria, templates, and a JDex. `wiki/`, `raw/`, `efforts/`, `inbox/` and `journal/` hold only `.gitkeep`. A benchmark on this revision would measure nothing. A synthetic corpus is the only near-term option, and its results transfer to real questions only partly.
2. **Bases and the Obsidian CLI do not run on the installed Obsidian.** The brain lint report records Obsidian 1.6.7. Bases arrived in 1.9.10 ([changelog p.6](https://obsidian.md/changelog/page/6)). The CLI arrived in 1.12.0 and needs installer 1.12.7+ ([changelog p.4](https://obsidian.md/changelog/page/4), [CLI help](https://obsidian.md/help/cli)). Every hub page embeds a `knowledge.base` view, so all 7 hubs show broken embeds today.
3. **The brain rules contradict ADR 0042 on `notes/`.** The Owner confirmed the ADR's model: Agents read `notes/` and only append suggestions. Sensitive material lives in the separate private repository, which is never cloned onto Agent machines. The brain's `AGENTS.md` ("Keep it out of Agent reads, searches, indexes, lint, and writes") and #273's exclusion of `notes/` from searches and indexes are therefore wrong and need correcting. Hermes could not have enforced the exclusion anyway. `search_files` has no exclude parameter ([file_tools.py L1301-1309](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/tools/file_tools.py)), and `terminal` bypasses the file-tool guards ([security.md](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/website/docs/user-guide/security.md)).
4. **Append-only is also an instruction, not a boundary.** `write_file` overwrites whole files and has no create-only mode. `HERMES_WRITE_SAFE_ROOT` limits writes by path prefix, not by operation. Git history is the real safety net, so lint should flag any commit that changes or removes existing lines in the brain.

## Answers to the issue's questions

### How a Hermes Agent should find and verify an answer

Default procedure (no measurement yet; reasoning from the tools' documented behavior):

1. Load the brain `AGENTS.md` as context by setting the Agent's `terminal.cwd` to the brain checkout. Hermes loads the first of `.hermes.md`, `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md`, walking from the git root down to the cwd ([context-files.md](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/website/docs/user-guide/features/context-files.md)). `OBSIDIAN_VAULT_PATH` and `WIKI_PATH` appear only in skill text, and no code reads them.
2. Orient with `_meta/topic-map.md` and the hub for the topic, then search with `search_files`. Scope searches to `wiki` and `raw` first for cited answers, then widen to `notes`, `efforts` and `areas`. Bound every search with `limit` and `output_mode`.
3. Read the wiki page, then follow its point-of-use citation into `raw/` and read the cited section before answering. If the wiki has a gap, search `raw/` directly and say that the answer has no wiki synthesis.
4. If the evidence conflicts, cite both claims. If nothing is found after a couple of reformulations, abstain.

**Index format.** The generated `_meta/index.md` lists only paths. Karpathy's pattern relies on an *annotated* index, a one-line summary per page that the Agent reads to choose pages ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)). Filenames alone give an Agent little to choose from, so add a one-line `summary` property (and optional `aliases`) to the wiki and source templates, and have `generate-index.ts` emit `path — summary`. Aliases also cover paraphrase misses for grep. This is a proposal that needs a SCHEMA change.

### Which retrieval tool

| Method | Fit | Cost and gaps |
| --- | --- | --- |
| Scoped `search_files` / `rg` + `read_file` | Default. Exact names, phrases and IDs, and following citations. Always fresh, no index. | Misses paraphrases that share no words. Output is capped (50 results by default, matched lines truncated at 500 chars, 100K-char tool result). One call per allowed folder. [file_operations_search.py](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/tools/file_operations_search.py) |
| qmd BM25 (`qmd search`) | Ranked lexical search once common terms flood grep. | Node ≥22 or Bun, plus `brew install sqlite` on macOS. Needs `qmd update` after changes (hash-based and incremental). [README](https://github.com/tobi/qmd/blob/v2.8.3/README.md#index-maintenance) |
| qmd hybrid (`qmd query`) | Paraphrases and cross-vocabulary questions. | About 2 GB of GGUF models on first run (embed ~300 MB, rerank ~640 MB, query expansion ~1.1 GB). `qmd embed` re-embeds whole changed docs. The MCP/HTTP daemon is unauthenticated on localhost. [README](https://github.com/tobi/qmd/blob/v2.8.3/README.md#gguf-models-via-node-llama-cpp) |
| Obsidian CLI `search` | Not for Agents. | Needs the desktop app running, with no headless mode. Its `search` has `path=` and `limit=`, but the link reports (`unresolved`, `orphans`, `deadends`) have no path filter. [CLI help](https://obsidian.md/help/cli) |

If qmd is added, use one collection per folder so a search can be limited to `wiki` and `raw` with `-c`. Exclude `_meta` index snapshots and `log/` with a YAML `ignore:` list ([index.yml](https://github.com/tobi/qmd/blob/v2.8.3/README.md#configuring-indexyml)).

The literature does not set a page-count threshold. Sen et al. ([arXiv:2605.15184](https://arxiv.org/abs/2605.15184), "Is Grep All You Need?") found that inline grep beat inline vector search in all 10 harness–model pairs, while programmatic delivery split the pairs 5–5. How results reach the Agent matters as much as which retriever produces them. RISE ([arXiv:2606.06880](https://arxiv.org/abs/2606.06880), Zhuang et al.) matched pure-shell accuracy at about a quarter of the cost by bounding shell exploration with BM25, on corpora orders of magnitude larger than this brain. "A few hundred pages" stays a review point, not a trigger.

**Conditions to add ranked or semantic retrieval.** Add qmd BM25 when grep regularly returns more matches than the result budget, or when Agents need 3+ reformulations to reach known evidence. Add hybrid only if a replay shows paraphrase recall@5 at least 15 points better than grep+aliases, with no loss on exact questions. Both thresholds are proposals.

### Which Owner workflows benefit from Bases

- **Why Bases entered the plan.** The November 11 planning session chose Bases over Dataview for topic and status dashboards. Bases is a core plugin, works on mobile, and adds no community plugin dependency. Dataview offers inline fields, DQL `TASK` queries and JS, none of which this brain uses ([Bases](https://obsidian.md/help/bases), [Dataview](https://github.com/blacksmithgu/obsidian-dataview)).
- **Syntax.** Both `.base` files use documented syntax: `file.inFolder`, `note.type`, `list(note.topic).contains(...)` and `groupBy` all appear in the docs ([syntax](https://obsidian.md/help/bases/syntax), [functions](https://obsidian.md/help/bases/functions)). They have not been rendered.
- **"Show active Career notes."** Run `obsidian base:query path="_meta/knowledge.base" view="Career" format=json` and filter `status == active` afterwards, because no view filters on status ([CLI help](https://obsidian.md/help/cli)). Agents can get the same answer more simply: `rg -l '^status: active' wiki efforts`, then check each result's `topic`.
- **Dependencies.** No Agent workflow depends on the `.base` files. The 7 hub pages, `SCHEMA.md`, `README.md`, `topic-map.md`, `lint-report.md` and ADR 0042 all reference them.
- **Decision: keep both `.base` files as Owner dashboards. No Agent workflow depends on them.** They cost nothing to maintain, use documented syntax, and give the Owner the topic and status views that motivated them. Agents answer structured questions with `rg` over frontmatter instead of `base:query`. Weekly lint uses `rg` and git checks instead of the Obsidian CLI, because the CLI needs the desktop app and its link reports lack path filters. Precondition: the Owner upgrades Obsidian to 1.12.7+ so the hub embeds render. Review the decision if the Owner hasn't opened a hub view after a month of real content. If so, remove the embeds and keep the hubs as link lists.

### Adapting the upstream Hermes skills

`llm-wiki` (507 lines) assumes a root `index.md` and `log.md`, `entities/` and `concepts/` folders, `updated` frontmatter bumps, overwriting superseded facts, splitting pages over 200 lines, archiving by moving to `_archive/`, and lint that renames and fixes. All of these conflict with the create-and-append-only rules. The `obsidian` skill defaults to `~/Documents/Obsidian Vault`, searches from the brain root, and appends with `write_file` rewrites or `terminal`. [llm-wiki](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/optional-skills/research/llm-wiki/SKILL.md) · [obsidian](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/skills/note-taking/obsidian/SKILL.md)

Keep: raw sources are immutable, orient before acting, search before creating, page-creation thresholds, at least 2 outbound links per page, ask before mass changes, and list every changed file in the log.

Replace:

| Upstream | Brain version |
| --- | --- |
| Root `index.md` / `log.md` | `_meta/index.md` via `generate-index.ts` (preview, then append). Daily log at `log/<agent>/YYYY-MM-DD.md` |
| `WIKI_PATH` / `OBSIDIAN_VAULT_PATH` | `terminal.cwd` set to the brain, plus absolute paths |
| Frontmatter `updated`, `confidence`, `contradictions` | Set at creation only. Later changes go in appended, dated sections. Contradictions are appended blocks or a `contradiction` page |
| `^[raw/...]` provenance markers | Relative link plus section or timestamp at the point of use |
| Overwrite, split, archive, move, rename | Proposal in `inbox/` |
| Lint fixes | Findings appended to `_meta/lint-report.md` |
| `write_file` / `patch` edits, `terminal` appends | `write_file` for new paths only (check existence first). `patch` anchored on the last line for appends. No `terminal` writes |
| Searches from the brain root | One `search_files` call per allowed folder |

Hermes always requires approval to write `AGENTS.md`, `CLAUDE.md` or `SOUL.md`, even in yolo mode ([file_tools_write_guards.py](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/tools/file_tools_write_guards.py)). `bot-hq` does not pin a Hermes version yet (#195).

## Repeatable evaluation design

To run once the brain or a synthetic corpus is ready. Protocol sources: BrowseComp-Plus ([arXiv:2508.06600](https://arxiv.org/abs/2508.06600)), ALCE citation metrics ([arXiv:2305.14627](https://arxiv.org/abs/2305.14627)), SQuAD 2.0 no-answer scoring ([arXiv:1806.03822](https://arxiv.org/abs/1806.03822)) and AbstentionBench ([arXiv:2506.09038](https://arxiv.org/abs/2506.09038)).

- **Corpus.** About 150 synthetic pages on a fixed brain commit, with wiki pages citing raw sources and a few `notes/` pages.
- **Questions.** 70 frozen test questions: 15 exact, 15 paraphrase, 10 multi-page, 10 source verification, 10 contradiction and 10 unanswerable, plus a separate dev set. `qrels.jsonl` gives each question's gold answer and evidence `path#section`.
- **Two stages.**
  - *Retrieval only (cheap, no LLM):* `qmd bench` takes a fixture of queries with `expected_files` and reports P@k, R@1/3/5, MRR and ms for bm25, vector, hybrid and full ([bench.ts](https://github.com/tobi/qmd/blob/v2.8.3/src/bench/bench.ts)). Add a small script that scores `rg` the same way.
  - *Agent:* the same Hermes model on every method. Each run gets at most 12 tool calls, top-k 5 with 300-character snippets or a 4 KB grep cap, 4 reads of at most 8 KB each, and a 120 s timeout. Run every question 3 times per method in random order.
- **Metrics.** Evidence recall@5, cited-answer correctness (judged by an LLM that is checked against about 50 hand labels), correct-abstention and false-answer rates, tool calls, tokens, latency (cold = first run in a fresh process, warm = median of later runs, with p50 and p90), and index build and refresh time after 1 and 20 page edits. Count timeouts separately.
- **Stats.** Paired McNemar per question type, and a paired bootstrap over questions (10k resamples) with Holm correction across method pairs.
- **Not available now.** The Obsidian CLI comparison needs the app at 1.12.7+ and cannot run headless. qmd hybrid needs a host with about 2 GB of model storage, and any heavy runs should go serially at low priority.

## Corrections to the brain's `_meta/retrieval-research.md`

- The link text in #273 does not match the papers' titles. 2605.15184 is "Is Grep All You Need? How Agent Harnesses Reshape Agentic Search" (Sen et al.). 2606.06880 is "Towards Retrieving Interaction Spaces for Agentic Search" (RISE, Zhuang et al.).
- Sen et al. say "programmatic" delivery, not "file-delivered". Oskooei et al. ([arXiv:2608.01507](https://arxiv.org/abs/2608.01507)) compare "semantic search" with "deep agentic search". Li et al. ([arXiv:2605.05242](https://arxiv.org/abs/2605.05242)) call their method "direct corpus interaction"; the 80% vs 69% result is in §4.2, and their degradation is with corpus growth from 100K to 200K documents, not with distractors. All numbers in the note are correct.
- Upstream `llm-wiki` moves pages only into `_archive/`; the brain forbids any move.
- Cite BEIR as [arXiv:2104.08663](https://arxiv.org/abs/2104.08663). The OpenReview link sits behind a verification wall.

## Decisions (2026-11-14)

1. **`notes/`.** Follow ADR 0042 as written: Agents read and append suggestions only. Fix the brain `AGENTS.md` scope bullets and drop "exclude notes/" from #273.
2. **Bases.** Keep both files as Owner dashboards after the Owner upgrades Obsidian to 1.12.7+. Agents don't depend on them, and lint uses `rg` and git instead of the Obsidian CLI. ADR 0042's line "uses the Obsidian CLI for lint" should change to match.
3. **Benchmark.** Deferred. Grep stays the default. Run the evaluation above once the brain has about 50 wiki pages, or when Agents report missed evidence, whichever comes first.
4. **Index.** Add a one-line `summary` and optional `aliases` to the wiki and source templates and SCHEMA. `generate-index.ts` emits `path — summary`.
