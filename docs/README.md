# Git Braid — docs index

| Document | Description |
|----------|-------------|
| [plan/project-plan.md](./plan/project-plan.md) | Full project plan (milestones, risks, tech choices, legal strategy) |
| [specs/layout-spec.md](./specs/layout-spec.md) | Layout algorithm System Contract (input/output/invariants/algorithm) |
| [adr/](./adr/) | Architecture decision records — why we chose what we chose |
| [guides/spec-template.md](./guides/spec-template.md) | Template for writing new System Contract specs |
| [guides/doc-conventions.md](./guides/doc-conventions.md) | rustdoc / TSDoc rules, doc language policy, when to write an ADR vs spec |

---

## How to use these docs

- **Starting a new feature?** Check `specs/` for an existing contract, or write
  one using `guides/spec-template.md` before coding.
- **Making an architectural decision?** Open an ADR in `adr/` using
  `adr/template.md` before or alongside implementation.
- **Writing code in `crates/core/`?** Read `specs/layout-spec.md` §5 invariants
  first — they are the correctness guarantees that virtualised rendering depends on.
- **Confused about a past choice?** Check `adr/` — if the rationale isn't
  there, write an ADR and file a PR.
