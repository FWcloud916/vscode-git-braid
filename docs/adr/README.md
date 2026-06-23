# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [0001](./0001-clean-room-not-fork.md) | Clean-room reimplementation, not a fork | Accepted |
| [0002](./0002-gitoxide-over-libgit2.md) | Use gitoxide (gix) for the git read path | Accepted |
| [0003](./0003-napi-over-wasm.md) | Use napi-rs native addon over WASM | Accepted |
| [0004](./0004-read-write-split.md) | Rust for reads, git CLI for writes | Accepted |
| [0005](./0005-diff-via-gitoxide-blob-provider.md) | Diff via gitoxide blob provider (not `git show`) | Accepted |
| [0006](./0006-repo-discovery-strategy.md) | Repository discovery strategy | Accepted |
| [0007](./0007-multi-provider-ai-backend.md) | Multi-provider AI backend + SecretStorage key management | Accepted |

New ADR? Copy `template.md`, increment the number, and add a row above.
