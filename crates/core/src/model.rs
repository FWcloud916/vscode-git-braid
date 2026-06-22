//! Cross-layer System Contracts for Git Braid.
//!
//! These types are the authoritative definition of the data exchanged between:
//! - Rust core (layout engine) ↔ napi binding ↔ TypeScript extension host
//! - Binary serialization → webview Canvas renderer
//!
//! **Do not change the shape of these types without updating:**
//! 1. `serialize.rs` (binary wire format)
//! 2. `bindings/napi/src/lib.rs` (FFI mapping)
//! 3. `src/webviewBridge.ts` (TypeScript side)
//! 4. `web/renderer/canvas.ts` (rendering loop)
//!
//! See `docs/specs/layout-spec.md` §3 (input contract) and §4 (output contract).

use bitflags::bitflags;
use smallvec::SmallVec;

// ─── Primitive aliases ────────────────────────────────────────────────────────

/// SHA-1 or SHA-256 object id, stored as a fixed 20-byte array.
///
/// For SHA-256 repos, only the first 20 bytes of the 32-byte hash are used
/// as the key in this layout pass; the full OID is stored separately in the
/// OID table. This is an intentional MVP trade-off.
pub type Oid = [u8; 20];

/// Index into the caller-owned colour palette (WebGL/Canvas decides the actual hex).
pub type ColorId = u8;

// ─── Input ───────────────────────────────────────────────────────────────────

/// A single commit as fed to the layout engine.
///
/// The caller (walk pass) must guarantee:
/// - `parents` appear *later* in the input slice (topological ordering).
/// - No duplicate OIDs in the slice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitIn {
    pub oid: Oid,
    /// `SmallVec<[Oid; 2]>` keeps root (0), normal (1), and merge (2) commits
    /// allocation-free. Octopus merges (3+) spill to the heap.
    pub parents: SmallVec<[Oid; 2]>,
}

// ─── Output ──────────────────────────────────────────────────────────────────

/// The fully-resolved geometry for one commit row.
///
/// Rows are emitted in the same order as the input `commits` slice
/// (index 0 = newest / top of graph).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowLayout {
    pub oid: Oid,
    /// Zero-based column index. 0 = leftmost lane.
    pub lane: u16,
    /// Colour of this commit node and its outgoing first-parent line.
    pub color: ColorId,
    /// Line segments in the **gap below this row** (between this row and the next).
    ///
    /// `SmallVec<[_; 4]>` keeps the common case (≤4 segments) allocation-free.
    pub segments: SmallVec<[Segment; 4]>,
    pub flags: RowFlags,
}

/// A directed line segment occupying the vertical gap between two adjacent rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    /// Lane at the top of this gap (the current-row side).
    pub from_lane: u16,
    /// Lane at the bottom of this gap (the next-row side).
    pub to_lane: u16,
    pub color: ColorId,
    pub kind: SegKind,
}

/// Visual semantics of a [`Segment`].
///
/// The renderer uses this to decide the curve shape of the line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SegKind {
    /// `from_lane == to_lane` — vertical straight line.
    Straight = 0,
    /// Merge commit's non-first parent: diagonal **right** from commit lane to a new lane.
    MergeOut = 1,
    /// Multiple lanes converging on the same parent: diagonal towards the surviving lane.
    ConvergeIn = 2,
}

bitflags! {
    /// Boolean attributes of a commit row, packed into a single byte.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
    pub struct RowFlags: u8 {
        /// This commit has ≥ 2 parents (merge commit).
        const IS_MERGE          = 0b0000_0001;
        /// This commit has 0 parents (root / initial commit).
        const IS_ROOT           = 0b0000_0010;
        /// At least one parent is not in the current loaded window.
        const PARENT_OFFSCREEN  = 0b0000_0100;
        /// No child in the current window points to this commit (graph tip).
        const IS_TIP            = 0b0000_1000;
        /// Synthetic node inserted by the caller (e.g. uncommitted changes).
        const IS_SYNTHETIC      = 0b0001_0000;
        /// Stash commit (special parent structure; flagged by caller).
        const IS_STASH          = 0b0010_0000;
    }
}

// ─── Incremental / paging state ──────────────────────────────────────────────

/// The minimal state required to continue layout from the bottom of one window
/// into the next loaded batch.
///
/// The host (`webviewBridge.ts`) stores this between batch requests.
/// The `waiting_index` (HashMap) is not serialized — it can be rebuilt from `lanes` O(L).
///
/// See `docs/specs/layout-spec.md` §11.
#[derive(Debug, Clone, Default)]
pub struct BoundaryState {
    /// Snapshot of the active lane vector at the window boundary.
    pub lanes: Vec<Option<LaneEntry>>,
    /// Monotonically-increasing colour counter. Ensures deterministic colour allocation
    /// across batch boundaries (spec §8 — `next_color % PALETTE_SIZE`).
    pub next_color: u32,
}

/// One slot in the active-lane vector: a lane that is "waiting" for a specific commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneEntry {
    /// The OID this lane is traveling toward (the commit it expects to see).
    pub waiting_for: Oid,
    pub color: ColorId,
}
