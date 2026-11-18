# Hermes setup uses an allowlist

Status: accepted, 2026-11-15.

Use the [Hermes setup spec](../agents/hermes-setup.md) to allowlist the modules, plugins, skills and tools each Agent may install or enable. Version the configuration in the repo and require the Owner to approve a spec PR before changing the allowlist or settings. This replaces setup choices made on individual machines with a reviewable record of each Agent's capabilities and a reproducible configuration.

Sources: [#366 setup decision](https://github.com/devdogfish/quantself/issues/366#issuecomment-6908222087) · [Approved baseline in PR #377](https://github.com/devdogfish/quantself/pull/377)
