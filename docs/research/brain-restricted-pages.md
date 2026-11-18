# Restricted pages in the brain

## Decision (2026-11-14): deferred

Restricted pages are not being built. Approval-gated reads would slow Agents down, and no page needs one yet. For now:

- **Sensitive details stay in the private repo,** which is never cloned onto Agent machines (ADR 0042).
- **The useful part goes in plain-language preferences.** For example, "Give me one next step at a time" goes in a plain brain page or Honcho, where it's harmless if it ever leaks.
- **Revisit** if an Agent did worse work more than once because it lacked something only a sensitive note contained. The design below is the starting point.

Use this test before saving a note:

1. Would it be fine word-for-word in a public post? Put it on a plain page.
2. Is it a secret or live data? Use Vaultwarden or Quantself.
3. Would any Agent ever work better with it? If not, it goes in the private repo. If so, it's a candidate for a restricted page later.

### Related decisions

[ADR 0048](../adr/0048-page-audience-and-client-brains.md) adds an `audience: public | internal | client-<slug>` property and per-client Client Brains for deep client research. Client records and paperwork remain open in [#183](https://github.com/devdogfish/quantself/issues/183).

## Research

Researched 2026-11-14 as a follow-up to [#273](https://github.com/devdogfish/quantself/issues/273) and [brain-retrieval.md](brain-retrieval.md).

**The question.** Can about 1% of brain pages (for example, medical context) stay in their natural folders while Agents read them only after Owner approval? What do others do, and what is best practice?

No setup described here was tested. Statements come from docs, source code and issue trackers. Items marked UNVERIFIED have no primary source.

## Answer

**It works only if the restricted pages are encrypted in Git and an approval service holds the key.** Path permissions, deny rules and prompt instructions cannot stop an Agent that has a shell and its own clone.

- **Recommended:** git-crypt on a fixed filename pattern, plus a small approval-gated read service. Nobody has published a test of this exact setup, so it would be new.
- **Community practice:** people restrict whole private folders, not individual pages, mostly through prompt rules or tool deny lists. Nobody has published a test showing it holds. No harness or Obsidian MCP server offers a human-approved read of one file that the shell cannot bypass.

## Why weaker controls fail

| Control | Why it fails here |
| --- | --- |
| Prompt rule ("don't read X") | OWASP warns that system-prompt restrictions "may not always be honored" and recommends least privilege enforced outside the model ([LLM02:2025](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/)). Prompt-injection benchmarks still report successful attacks: InjecAgent 24% on GPT-4 ReAct ([arXiv:2403.02691](https://arxiv.org/abs/2403.02691)), and AgentDojo shows the best attacks still landing with defenses ([arXiv:2406.13352](https://arxiv.org/abs/2406.13352)). |
| Harness deny rules | Hermes calls its read denylist "not a hard boundary", because `terminal` can still `cat` denied files ([security docs](https://hermes-agent.nousresearch.com/docs/user-guide/security), [PR #30721](https://github.com/NousResearch/hermes-agent/pull/30721)). Claude Code users report Bash reading files that `Read` denies ([#45200](https://github.com/anthropics/claude-code/issues/45200)), and its docs point to an OS sandbox for enforcement ([permissions](https://code.claude.com/docs/en/permissions)). Cursor calls its guardrails best-effort ([agent security](https://cursor.com/docs/agent/security)). |
| OS file permissions | Git tracks only the executable bit, and a clone is owned by whoever cloned it ([core.fileMode](https://git-scm.com/docs/git-config)). Anyone who can read `.git` recovers every version with `git show` or `git cat-file` ([git-cat-file](https://git-scm.com/docs/git-cat-file)). Partial clones fetch missing blobs on demand ([partial clone](https://git-scm.com/docs/partial-clone)), and sparse checkout only changes the working tree ([sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)). |
| Git server path rules | Git has no per-path read permissions. Gitea and Forgejo grant access per repository unit, not per path ([Gitea forum](https://forum.gitea.com/t/does-gitea-permit-file-level-or-partial-repo-permissions-settings/6323)). |
| Process sandbox | Landlock, bubblewrap and systemd `InaccessiblePaths=` can hide paths from a process and its shell ([Landlock](https://docs.kernel.org/userspace-api/landlock.html), [bubblewrap](https://github.com/containers/bubblewrap), [systemd.exec](https://www.man7.org/linux/man-pages/man5/systemd.exec.5.html)). The content is still in `.git/objects`, though, so the Agent would also have to lose access to `.git`, which breaks its Git workflow. |

Meta's "Agents Rule of Two" applies directly. A session that combines untrusted input, sensitive data and external actions (such as posting to LinkedIn) needs human approval ([Meta](https://ai.meta.com/blog/practical-ai-agent-security/)). Encryption keeps the sensitive data out of a session unless you approve it.

## What others do

- **Most setups exclude whole folders, by prompt or `.gitignore`.** This includes Karpathy's LLM wiki pattern, the Hermes `llm-wiki` skill, `fcwu/llm-wiki-agent`, and several Obsidian + Claude Code write-ups ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [Hermes llm-wiki](https://hermes-agent.nousresearch.com/docs/user-guide/skills/optional/research/research-llm-wiki), [okhlopkov](https://okhlopkov.com/second-brain-obsidian-claude-code/)). None reports a leak test.
- **Some tools enforce at the tool level.** `cyanheads/obsidian-mcp-server` has `OBSIDIAN_DENY_PATHS`, which hides folders from listings, search, reads and writes ([repo](https://github.com/cyanheads/obsidian-mcp-server)). Other MCP servers claim ignored or forbidden folders (UNVERIFIED). This holds only when the Agent has no shell or direct file access.
- **Memory platforms.** Letta supports read-only memory blocks, but per-Agent block access is deprecated ([docs](https://docs.letta.com/guides/core-concepts/memory/memory-blocks/index.md)). Basic Memory documents no access control ([repo](https://github.com/basicmachines-co/basic-memory)).
- **Approval brokers.** Patterns like Auth0 Token Vault + CIBA or MCP gateway approvals gate tokens and tools, not reads of Markdown files ([Descope](https://www.descope.com/blog/post/ciba-ai-agents-hooks), [TrueFoundry](https://www.truefoundry.com/docs/ai-gateway/mcp/mcp-tool-approval)). These are vendor examples, not a standard.

## Encryption options

| Option | Fit | Problems |
| --- | --- | --- |
| **git-crypt** | Transparent Git filter selected by `.gitattributes` patterns. Your working tree stays plain text, so Obsidian, Bases and search work normally. Clones without the key see ciphertext. Latest release 0.8.0 (2025-09). Supports multiple GPG recipients or a symmetric key. [README](https://github.com/AGWA/git-crypt) | Paths, sizes and change times stay visible. Removing a key never re-encrypts history. A file committed before its pattern existed stays plain text forever. |
| git-agecrypt | Same transparent model with age, SSH or YubiKey recipients. [README](https://github.com/vlaci/git-agecrypt) | No releases, and the author says it is unaudited. |
| Meld Encrypt (Obsidian plugin) | AES-256-GCM with PBKDF2, whole-note `.mdenc` files or inline blocks. Maintained (v3.1.1, 2026-10). Has a documented format plus standalone decrypt tools. [repo](https://github.com/meld-cp/obsidian-encrypt), [format](https://github.com/meld-cp/obsidian-encrypt/blob/main/docs/dev-notes.md) | Encrypted on your Mac too, so Bases, search and links can't see the content. Password only. Every save rewrites the whole encrypted file, so Git can't diff or merge it. Its own docs say it is unaudited. |
| SOPS | Strong key management. [README](https://github.com/getsops/sops) | Built for structured files; Markdown would be encrypted as one opaque blob, with no transparent working tree. |
| transcrypt, git-secret, BlackBox | Rejected. | transcrypt uses unauthenticated CBC with a shared password, git-secret's last release was 2022, and BlackBox is archived. [transcrypt](https://github.com/elasticdog/transcrypt), [git-secret](https://github.com/sobolevn/git-secret/blob/master/README.md), [BlackBox](https://github.com/StackExchange/blackbox) |

Obsidian core has no per-note permissions. Sync encryption covers the whole Obsidian vault, and Publish password-protects the whole site ([Sync security](https://obsidian.md/help/sync/security), [Publish security](https://obsidian.md/help/publish/security)).

## Recommended design

1. **Mark restricted pages by filename.** Use a fixed suffix in their normal folder, e.g. `wiki/focus-and-energy.restricted.md`, and one `.gitattributes` line: `*.restricted.md filter=git-crypt diff=git-crypt`. A pattern can't be forgotten the way one line per path can. The cost is that the filename shows the page is restricted, but not what it says.
2. **Block accidental plain-text commits.** A pre-commit hook runs `git-crypt status -e` and rejects any `*.restricted.md` that isn't encrypted.
3. **Keep the key off Agent machines.** Your Mac holds it, so you see plain text everywhere. Agent clones get ciphertext.
4. **Approval-gated read service.** It runs as a separate OS user (or host) that holds the key. An Agent calls `request_restricted(path, reason)`. You approve or deny in Bot HQ. On approval, the service returns that one page's plain text for that request only, and logs the read.
5. **Keep a findable stub.** Each restricted page has a public neighbour, e.g. `focus-and-energy.md`, with a neutral summary and a link. Agents find it by search and know to request the full page.
6. **Agents don't write to restricted pages.** They append suggestions to the public neighbour or the inbox instead.

**Limits:**
- An approved read sits in that Agent's session and may reach its memory.
- Filenames, sizes and edit times stay visible.
- Removing someone's key doesn't re-encrypt history. Revoking access means rotating the key and accepting that old clones keep old ciphertext they can decrypt with the old key.
- The obsidian-git plugin on mobile uses isomorphic-git, which may not run git-crypt filters (UNVERIFIED). Commit restricted pages only from the desktop.

## Changes this implies

- **ADR 0042.** Replace "never enter the brain" for sensitive material with a restricted-page tier: git-crypt plus approval-gated reads. Secrets and credentials stay in Vaultwarden and Quantself.
- **Brain.** Update `SCHEMA.md` and `AGENTS.md` for `*.restricted.md` and stub pages. Add `.gitattributes` and the pre-commit hook.
- **Hermes.** Add a `request_restricted` tool. Keep the key outside every Agent's OS user.
- **Before relying on it,** test with fake content:
  - an Agent clone shows ciphertext through `cat`, `git show` and search
  - the pre-commit hook blocks plain text
  - approval and denial work
  - the mobile commit path is safe
