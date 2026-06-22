# Documentation conventions

This guide describes when and how to write documentation in the Git Braid project.

---

## When to write what

| Situation | Doc type | Where |
|-----------|----------|-------|
| Making a non-obvious architectural choice | ADR | `docs/adr/NNNN-slug.md` |
| Defining a cross-layer contract (algorithm, protocol, data model) | Spec (System Contracts) | `docs/specs/slug.md` |
| Updating milestone status or tracking blockers | Progress update | `PROGRESS.md` |
| Documenting a user-visible feature | — | In-code doc comments + README |
| Explaining a surprising implementation choice inside a file | Inline comment | In the source file |

**Rule of thumb:** if a future Claude Code session or contributor would need to read more
than one file to understand *why* something is the way it is, write an ADR. If they need to
understand the *contract* of an algorithm or protocol, write a spec.

---

## Rust: rustdoc conventions

```rust
/// One-line summary (imperative mood, no period at end).
///
/// Longer description if needed. Explain *why*, not just *what*.
///
/// # Arguments
///
/// * `foo` — what it is and any constraints (e.g. must be sorted).
///
/// # Returns
///
/// What the return value represents.
///
/// # Errors
///
/// When and what errors can occur (for `Result`-returning functions).
///
/// # Panics
///
/// If the function panics under any circumstance, document it here.
///
/// # Examples
///
/// ```rust
/// let result = my_function(42);
/// assert_eq!(result, 84);
/// ```
pub fn my_function(foo: u32) -> u32 { … }
```

**Required rustdoc:**
- Every `pub` item in `model.rs`, `layout.rs`, `walk.rs`, `serialize.rs`.
- Every `pub` item in `bindings/napi/src/lib.rs`.
- Struct fields that are non-obvious.

**Inline comments (`//`):** use for why-not-what. "// topological order is required by layout invariant 5" beats "// iterate commits".

---

## TypeScript: TSDoc conventions

```ts
/**
 * One-line summary (imperative mood).
 *
 * Longer description. Explain *why*, not just *what*.
 *
 * @param foo - What it is, any constraints.
 * @returns What the return value represents.
 * @throws {ErrorType} When and why.
 *
 * @example
 * const result = myFunction(42);
 * console.log(result); // 84
 */
export function myFunction(foo: number): number { … }
```

**Required TSDoc:**
- All exported functions, classes, and types in `src/` and `web/`.
- Phase/status stubs must include a `@remarks Phase N — not yet implemented` note.

---

## Language policy

| File location | Language |
|---------------|---------|
| `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `PROGRESS.md` | English |
| `docs/adr/`, `docs/guides/` | English |
| `docs/plan/`, `docs/specs/` | Traditional Chinese (existing files), English (new files) |
| Source code doc comments | English |

The planning documents in `docs/plan/project-plan.md` and
`docs/specs/layout-spec.md` were authored in Traditional Chinese and should
remain as-is. New specs and ADRs should be in English for maximum
contributor accessibility.

---

## ADR vs spec: the decision boundary

Write an **ADR** when: you chose X over Y, and someone will ask "why not Y?" in six months.

Write a **spec** when: you are defining a contract (input/output/invariants) that two or more
modules or layers depend on.

A spec can reference an ADR for rationale. An ADR can link to a spec for the contract that
resulted from the decision. They are complementary.

---

## Stub documentation policy

Every stub function must document its implementation target:

- Rust: `// M0 implementation target. See docs/specs/…`
- TypeScript: `// TODO(MN): …`

When a stub is implemented, remove the stub note and replace with real documentation.
