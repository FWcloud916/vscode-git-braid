//! Criterion benchmarks for the layout engine.
//!
//! Run with:
//!   cargo bench --package git-braid-core
//!
//! Performance targets (plan §6.1):
//! - First paint < 500ms for 10k commits
//! - Batch latency < 100ms

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use git_braid_core::model::CommitIn;
use smallvec::smallvec;

/// Build a simple linear chain of N commits (no branches).
fn linear_chain(n: usize) -> Vec<CommitIn> {
    let mut commits = Vec::with_capacity(n);
    for i in 0..n {
        let mut oid = [0u8; 20];
        // encode index into first 8 bytes (little-endian)
        oid[..8].copy_from_slice(&(i as u64).to_le_bytes());

        let parents = if i + 1 < n {
            let mut parent_oid = [0u8; 20];
            parent_oid[..8].copy_from_slice(&((i + 1) as u64).to_le_bytes());
            smallvec![parent_oid]
        } else {
            smallvec![]
        };

        commits.push(CommitIn { oid, parents });
    }
    commits
}

fn bench_layout_linear(c: &mut Criterion) {
    let mut group = c.benchmark_group("layout/linear");
    for size in [1_000usize, 10_000, 100_000] {
        let commits = linear_chain(size);
        group.bench_with_input(BenchmarkId::from_parameter(size), &commits, |b, commits| {
            b.iter(|| {
                let (rows, boundary) =
                    git_braid_core::layout::layout(black_box(commits), black_box(None));
                black_box((rows, boundary));
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_layout_linear);
criterion_main!(benches);
