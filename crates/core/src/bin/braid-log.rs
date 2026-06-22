//! `braid-log` — M0 CLI demo for `walk_commits`.
//!
//! Prints topo-sorted commits from a git repository to stdout, one per line.
//! Demonstrates correctness (topo order) and gives a rough first-paint timing.
//!
//! Usage:
//!   cargo run -p git-braid-core --bin braid-log -- [PATH] [OPTIONS]
//!
//! Options:
//!   --date          Use date-order instead of topo-order
//!   --first-parent  Follow only first-parent edges
//!   --limit <N>     Return at most N commits
//!
//! PATH defaults to "." (current directory).

use git_braid_core::walk::{walk_commits, SortOrder, WalkOptions};
use std::{env, path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut repo_path = PathBuf::from(".");
    let mut opts = WalkOptions::default();
    let mut path_set = false;

    let mut args = env::args().skip(1).peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--date" => opts.order = SortOrder::Date,
            "--first-parent" => opts.first_parent_only = true,
            "--limit" => {
                let n = args
                    .next()
                    .ok_or("--limit requires a number")?
                    .parse::<usize>()
                    .map_err(|e| format!("--limit: {e}"))?;
                opts.limit = Some(n);
            }
            other if other.starts_with("--") => {
                eprintln!("unknown flag: {other}");
                print_usage();
                std::process::exit(1);
            }
            path => {
                if path_set {
                    eprintln!("unexpected argument: {path}");
                    print_usage();
                    std::process::exit(1);
                }
                repo_path = PathBuf::from(path);
                path_set = true;
            }
        }
    }

    let t0 = Instant::now();
    let commits = walk_commits(&repo_path, &opts)?;
    let elapsed = t0.elapsed();

    // Header
    let order_label = match opts.order {
        SortOrder::TopoDate => "topo-order",
        SortOrder::Date => "date-order",
    };
    let first_parent_label = if opts.first_parent_only {
        " --first-parent"
    } else {
        ""
    };
    let limit_label = opts
        .limit
        .map_or_else(String::new, |n| format!(" --limit {n}"));
    println!(
        "# braid-log  repo={}  [{order_label}{first_parent_label}{limit_label}]",
        repo_path.display()
    );
    println!("{:>6}  {:7}  parents", "index", "oid");
    println!("{:-<50}", "");

    // Rows
    for (i, commit) in commits.iter().enumerate() {
        let oid_hex = hex7(&commit.oid);
        let parents: Vec<String> = commit.parents.iter().map(hex7).collect();
        println!("{i:>6}  {oid_hex}  {}", parents.join(" "));
    }

    println!("{:-<50}", "");
    println!(
        "# {} commits  elapsed: {:.3}ms",
        commits.len(),
        elapsed.as_secs_f64() * 1000.0
    );

    Ok(())
}

fn print_usage() {
    eprintln!("Usage: braid-log [PATH] [--date] [--first-parent] [--limit N]");
}

/// Format the first 7 hex chars of a 20-byte OID (like git's short SHA).
fn hex7(oid: &[u8; 20]) -> String {
    oid.iter()
        .take(4) // 4 bytes = 8 hex chars; we print 7
        .fold(String::with_capacity(8), |mut s, b| {
            s.push_str(&format!("{b:02x}"));
            s
        })[..7]
        .to_string()
}
