# Brain pages carry an audience, and deep client work gets its own Client Brain

Status: accepted, 2026-11-14.

This extends [ADR 0042](0042-memory-layers.md). Agents draft public posts, client documents and internal work from the same brain. Until now, nothing said which pages may leave the brain.

## Decision

Every brain page carries an `audience` frontmatter property:

| Value | Content may appear in |
| --- | --- |
| `public` | Public output, such as posts, comments and published content |
| `internal` | Work for the Owner and Agents only |
| `client-<slug>` | Output for that client only |

A missing value means `internal`. When an Agent creates a page, it picks the most restrictive value that fits. Output inherits the most restrictive audience of the pages it draws on. Agents may not widen a page's audience; they append a request for the Owner instead.

Client knowledge has two homes:

- **Light, non-sensitive client facts** stay in the main brain, marked `client-<slug>` or `internal`. Examples include who the client is, the engagement, and reusable lessons.
- **Deep research into one client's business** goes in a separate Client Brain: a Git repository named `brain-client-<slug>` with the same layout and rules. Its pages default to `client-<slug>`, and an `efforts/` page in the main brain links to it. This keeps the main brain focused and the client material in one place.

`notes/` follows ADR 0042: Agents read the Owner's notes and only append suggestions.

## Consequences

- The `audience` rule is enforced by instructions only. Agents with shell access can still read and quote any page, so the Owner's approval of public output remains the real safeguard. Secrets and sensitive personal details stay out of the brain entirely.
- Restricted, approval-gated pages were researched and deferred ([brain-restricted-pages.md](../research/brain-restricted-pages.md)).
- Client records and onboarding paperwork remain an open question in [#183](https://github.com/devdogfish/quantself/issues/183). Client Brains hold research and knowledge, not records. Where Client Brains are hosted must respect whatever #183 decides about keeping client data off home machines.
