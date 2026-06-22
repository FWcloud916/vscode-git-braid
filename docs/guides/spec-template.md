# [Module] — [Short description]

> Version: v0.1
> Corresponds to: [link to plan or ADR]
> Implementation target: `path/to/file.rs` or `path/to/file.ts`
> Nature: [Pure function spec | Protocol spec | Behaviour spec]

---

## 1. Purpose and scope

_What does this module do? Why is this spec needed?_

### In scope
- _List the things this module is responsible for._

### Out of scope
- _Explicitly list what is handled by other modules to avoid confusion._

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **foo** | … |
| **bar** | … |

---

## 3. Input contract

```
Input:
  field: Type   // description
  field: Type
```

Preconditions (the caller guarantees; this module does not validate):
- _List invariants that must hold on input._

---

## 4. Output contract (data model)

```
Output:
  field: Type   // description
```

---

## 5. Invariants

_State the invariants that must hold on the output. These are what tests verify._

1. **Name**: description.
2. **Name**: description.

---

## 6. Core algorithm

_Describe the algorithm in pseudocode or prose. Precise enough that an
implementor doesn't need to invent it, but not tied to a specific language._

---

## 7. Worked example

_Walk through a concrete input and trace the expected output step by step.
This becomes the first golden test._

---

## 8. Edge cases

| Case | Handling |
|------|---------|
| empty input | … |
| maximum size | … |

---

## 9. Performance notes

_Time/space complexity. Any allocation strategy decisions._

---

## 10. Open decisions

_Things not yet decided. Number them so they can be referenced._

1. **Title**: description.

---

## 11. Interface with other modules

- **Upstream**: consumes output of [X].
- **Downstream**: output consumed by [Y].
- **Parallel**: [Z] runs alongside; no feedback loop.

---

_v0.1 — expected to iterate after initial implementation._
