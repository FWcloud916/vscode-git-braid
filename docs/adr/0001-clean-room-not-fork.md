# ADR-0001: Clean-room reimplementation, not a fork

**Date:** 2026-06-22
**Status:** Accepted

---

## Context

The original Git Graph extension (mhutchie/vscode-git-graph) has no open-source
licence. Under copyright law, "all rights reserved" is the default when no
licence is provided: anyone can view the code on GitHub (using the GitHub
Terms of Service implied licence for reading), but cannot use, copy, modify,
or distribute it in their own work.

The community consensus (issue threads #804 and #838 in the original repo)
is that the only legally safe path to a similar extension is a clean-room
reimplementation: build from observable behaviour and public git documentation,
without opening or referencing the original source code.

A formal fork or hard copy would expose contributors and users to copyright
liability, which is unacceptable for a project intended to be open-source.

---

## Decision

Git Braid is a **clean-room reimplementation** of the Git Graph concept.
The development process is:

1. Write a **behaviour specification** by observing the running extension
   (what the user sees and does), not by reading its code.
2. Implement against the behaviour spec, using public git documentation and
   algorithm literature as references.
3. Never open the original extension's source files during development.
4. Maintain the git commit log as the evidence chain.

The project is licensed under MIT.

---

## Consequences

**Positive:**
- No copyright liability for the project or contributors.
- The project can be freely distributed, forked, and commercially used (MIT).
- A clean implementation may find better abstractions than the original.

**Negative / trade-offs:**
- More upfront work: must write behaviour specs before coding.
- Cannot adopt any code or algorithms directly from the original.
- Clean-room discipline requires ongoing vigilance from all contributors.

**Neutral / follow-up:**
- The "observable behaviour" specs live in `docs/specs/`.
- Before serious commercial use (e.g. paid AI tier), consult a lawyer to
  confirm the clean-room process is documented sufficiently.
