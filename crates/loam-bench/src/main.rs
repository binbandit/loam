//! Loam performance harness (§5.9/§5.12). Scenarios are deterministic and
//! self-contained; `--check` enforces the SLO and regression gates and exits
//! non-zero on violation (wired into the CI perf-smoke job).
//!
//! Usage:
//!   loam-bench switcher            # run bench-10k switcher scenarios, print report
//!   loam-bench switcher --check    # additionally enforce SLO + regression gates
//!   loam-bench switcher --write-baseline  # refresh baselines/switcher.json

use std::time::Instant;

use loam_core::search::{Frecency, SwitchRecord, Switcher, SwitcherSession};

const RECORDS: usize = 10_000;
const ITERATIONS: usize = 40;
const NOW_MS: i64 = 1_752_000_000_000;

/// Absolute SLO gates: the omnibar keystroke budget is 30 ms end to end;
/// core's allocated share for the FIRST batch is half of it.
const FIRST_BATCH_P95_SLO_MS: f64 = 15.0;
const TOTAL_P95_SLO_MS: f64 = 30.0;
const EMPTY_QUERY_P95_SLO_MS: f64 = 5.0;
/// A run slower than baseline × 1.10 is a regression and fails `--check`.
const REGRESSION_FACTOR: f64 = 1.10;

const WORDS: [&str; 24] = [
    "atlas", "brook", "cedar", "delta", "ember", "fjord", "grove", "harbor", "island", "juniper",
    "kelp", "lagoon", "meadow", "north", "orchid", "pine", "quarry", "ridge", "summit", "trail",
    "upland", "valley", "willow", "zephyr",
];

/// Deterministic synthetic bench-10k record set (§5.9 reference shape).
fn bench_records() -> Vec<(String, SwitchRecord)> {
    let mut out = Vec::with_capacity(RECORDS);
    for i in 0..RECORDS {
        let a = WORDS[i % WORDS.len()];
        let b = WORDS[(i / WORDS.len()) % WORDS.len()];
        let c = WORDS[(i / (WORDS.len() * WORDS.len())) % WORDS.len()];
        let folder = WORDS[(i / 7) % WORDS.len()];
        let path = format!("{folder}/{a}-{b}-{i:05}.md");
        let record = SwitchRecord {
            title: format!("{a} {b} {c} {i:05}"),
            aliases: if i % 5 == 0 {
                vec![format!("{c} alias {i}")]
            } else {
                Vec::new()
            },
            headings: vec![format!("{b} overview"), format!("{c} details")],
        };
        out.push((path, record));
    }
    out
}

fn p95(samples: &mut [f64]) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let index = ((samples.len() as f64) * 0.95).ceil() as usize - 1;
    samples[index.min(samples.len() - 1)]
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitcherReport {
    records: usize,
    iterations: usize,
    first_batch_p95_ms: f64,
    total_p95_ms: f64,
    empty_query_p95_ms: f64,
}

fn run_switcher_scenario() -> SwitcherReport {
    let mut switcher = Switcher::new();
    for (path, record) in bench_records() {
        switcher.insert_record(path, record);
    }
    let mut session = SwitcherSession::new(switcher);
    let frecency = {
        let mut frecency = Frecency::load(std::path::Path::new("/nonexistent/frecency.json"));
        for i in 0..50 {
            frecency.record_open(&format!("atlas/atlas-brook-{i:05}.md"), NOW_MS - i);
        }
        frecency
    };
    let generation = session.generation();

    let queries = [
        "cedar",
        "wil low",
        "harbor overview",
        "qrry",
        "zephyr valley",
    ];
    let mut first_batch = Vec::new();
    let mut totals = Vec::new();
    for iteration in 0..ITERATIONS {
        let query = queries[iteration % queries.len()];
        let this_generation = generation.supersede();
        let (_, timing) = session
            .run(this_generation, &frecency, NOW_MS, query, 10, &mut |_| {})
            .expect("query");
        first_batch.push(timing.first_batch_ms);
        totals.push(timing.total_ms);
    }

    let mut empties = Vec::new();
    for _ in 0..ITERATIONS {
        let this_generation = generation.supersede();
        let started = Instant::now();
        session
            .run(this_generation, &frecency, NOW_MS, "", 10, &mut |_| {})
            .expect("empty query");
        empties.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    SwitcherReport {
        records: RECORDS,
        iterations: ITERATIONS,
        first_batch_p95_ms: p95(&mut first_batch),
        total_p95_ms: p95(&mut totals),
        empty_query_p95_ms: p95(&mut empties),
    }
}

/// Result stability (AC3): the same query returns identical paths across
/// fresh sessions.
fn assert_stability() {
    let run = || {
        let mut switcher = Switcher::new();
        for (path, record) in bench_records() {
            switcher.insert_record(path, record);
        }
        switcher
            .query("cedar", 25, &|| false)
            .expect("query")
            .into_iter()
            .map(|h| h.path)
            .collect::<Vec<_>>()
    };
    let first = run();
    let second = run();
    assert_eq!(first, second, "bench-10k results must be stable");
    assert!(!first.is_empty());
    eprintln!("stability: {} identical hits across runs", first.len());
}

fn baseline_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("baselines/switcher.json")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let scenario = args.first().map(String::as_str).unwrap_or("switcher");
    if scenario != "switcher" {
        eprintln!("unknown scenario: {scenario} (available: switcher)");
        std::process::exit(2);
    }
    let check = args.iter().any(|a| a == "--check");
    let write_baseline = args.iter().any(|a| a == "--write-baseline");

    assert_stability();
    let report = run_switcher_scenario();
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("serializes")
    );

    if write_baseline {
        std::fs::create_dir_all(baseline_path().parent().expect("parent")).expect("mkdir");
        std::fs::write(
            baseline_path(),
            serde_json::to_string_pretty(&report).expect("serializes") + "\n",
        )
        .expect("write baseline");
        eprintln!("baseline written to {}", baseline_path().display());
        return;
    }

    if check {
        let mut failures = Vec::new();
        let mut gate = |name: &str, measured: f64, slo: f64, baseline: Option<f64>| {
            if measured > slo {
                failures.push(format!("{name}: {measured:.2} ms exceeds SLO {slo:.2} ms"));
            }
            if let Some(baseline) = baseline {
                let ceiling = baseline * REGRESSION_FACTOR;
                if measured > ceiling {
                    failures.push(format!(
                        "{name}: {measured:.2} ms regresses >10% over baseline {baseline:.2} ms"
                    ));
                }
            }
        };
        let baseline: Option<SwitcherReport> = std::fs::read_to_string(baseline_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        gate(
            "first-batch p95",
            report.first_batch_p95_ms,
            FIRST_BATCH_P95_SLO_MS,
            baseline.as_ref().map(|b| b.first_batch_p95_ms),
        );
        gate(
            "total p95",
            report.total_p95_ms,
            TOTAL_P95_SLO_MS,
            baseline.as_ref().map(|b| b.total_p95_ms),
        );
        gate(
            "empty-query p95",
            report.empty_query_p95_ms,
            EMPTY_QUERY_P95_SLO_MS,
            baseline.as_ref().map(|b| b.empty_query_p95_ms),
        );
        if !failures.is_empty() {
            for failure in &failures {
                eprintln!("FAIL {failure}");
            }
            std::process::exit(1);
        }
        eprintln!("perf gates passed");
    }
}
