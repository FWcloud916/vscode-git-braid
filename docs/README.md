# Git Braid — docs index

## Start here

| Document | Description |
|----------|-------------|
| [architecture.md](./architecture.md) | **Full architecture record** — component diagram, data-flows, tech stack, hard constraints |
| [CODEMAP.md](./CODEMAP.md) | **Project-wide code map** — per-file reference for all 22 core source files; "where do I change X?" tables |
| [ai/README.md](./ai/README.md) | **AI subsystem hub** — feature→file navigation, privacy model, configuration surface |

## Specs

| Document | Description |
|----------|-------------|
| [specs/layout-spec.md](./specs/layout-spec.md) | Layout algorithm System Contract (input/output/invariants/algorithm) |
| [specs/ai-provider-spec.md](./specs/ai-provider-spec.md) | AIProvider protocol — per-provider system-role normalisation, error contract |
| [specs/ai-release-notes-spec.md](./specs/ai-release-notes-spec.md) | Release-notes command behaviour — 10-step flow, prompt contract, privacy levels |

## Planning and decisions

| Document | Description |
|----------|-------------|
| [plan/project-plan.md](./plan/project-plan.md) | Full project plan (milestones, risks, tech choices, legal strategy) |
| [ai/planned-features.md](./ai/planned-features.md) | Architecture notes for three planned AI features (semantic search, conflict summary, commit-message suggestion) |
| [adr/](./adr/) | Architecture decision records — why we chose what we chose |

## Guides

| Document | Description |
|----------|-------------|
| [guides/spec-template.md](./guides/spec-template.md) | Template for writing new System Contract specs |
| [guides/doc-conventions.md](./guides/doc-conventions.md) | rustdoc / TSDoc rules, doc language policy, when to write an ADR vs spec |

---

## How to use these docs

- **New to the codebase?** Read `architecture.md` for the big picture, then `CODEMAP.md` for which file to open.
- **Starting a new feature?** Check `specs/` for an existing contract, or write
  one using `guides/spec-template.md` before coding.
- **Making an architectural decision?** Open an ADR in `adr/` using
  `adr/template.md` before or alongside implementation.
- **Writing code in `crates/core/`?** Read `specs/layout-spec.md` §5 invariants
  first — they are the correctness guarantees that virtualised rendering depends on.
- **Working on the AI subsystem?** Start with `ai/README.md`, then read the relevant spec.
- **Confused about a past choice?** Check `adr/` — if the rationale isn't
  there, write an ADR and file a PR.
