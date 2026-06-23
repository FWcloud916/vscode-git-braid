//! # git-braid-core
//!
//! The Rust performance core for Git Braid — a VS Code extension for visualising
//! git history. This crate owns:
//!
//! - **`model`** — cross-layer data contracts (`CommitIn`, `RowLayout`, `BoundaryState`, …)
//! - **`walk`** — gitoxide-based log walk (hot read path, no subprocesses)
//! - **`layout`** — pure graph layout engine (lane / colour / segment assignment)
//! - **`serialize`** — flat binary encoding for the host ↔ webview protocol
//!
//! ## Architecture
//!
//! ```text
//! git ODB  ──[gix]──▶  walk.rs  ──▶  layout.rs  ──▶  serialize.rs
//!                                                           │
//!                                                    ArrayBuffer ──▶ webview Canvas
//! ```
//!
//! This crate is exposed to TypeScript via napi-rs (see `bindings/napi`).
//! All write operations (checkout, merge, …) are handled in the TS extension
//! host via `git` CLI subprocess — this crate is **read-only**.
//!
//! See `docs/specs/layout-spec.md` for the layout algorithm contract and
//! `docs/plan/project-plan.md` for the overall architecture.

pub mod layout;
pub mod model;
pub mod serialize;
pub mod walk;

// Re-export the most commonly-used public API.
pub use layout::layout;
pub use model::{
    BoundaryState, BranchInfo, CommitIn, CommitMeta, LaneEntry, RefInfo, RefKind, RefLabel,
    RowLayout, SegKind, Segment,
};
