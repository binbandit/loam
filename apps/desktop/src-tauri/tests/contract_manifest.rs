//! LOA-65: the normalized M0 IPC contract manifest, snapshotted in CI.
//!
//! The manifest is DERIVED from the committed generated bindings (which are
//! themselves byte-drift-checked against the Rust command surface by
//! `bindings_drift`), so the chain Rust → bindings.ts → manifest cannot
//! silently diverge at any link. Regenerate after intentional changes with:
//! `LOAM_UPDATE_FIXTURES=1 cargo test -p loam-desktop --test contract_manifest`

use std::path::PathBuf;

fn bindings() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/ipc-client/src/generated/bindings.ts");
    std::fs::read_to_string(path).expect("generated bindings committed")
}

fn manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../docs/ipc-contract-manifest.json")
}

/// Build the normalized manifest from the generated client + the event
/// contract constants. Deterministic: everything is sorted.
fn build_manifest() -> serde_json::Value {
    let source = bindings();

    // Commands live in the `export const commands = { … };` object. Entries
    // are tab-indented and may span lines (inline result types), so parse the
    // whole block per entry, with whitespace normalized.
    let block = source
        .split_once("export const commands = {")
        .map(|(_, tail)| {
            tail.split_once("\n};")
                .map(|(body, _)| body)
                .unwrap_or(tail)
        })
        .unwrap_or_default();
    // Group physical lines into logical entries: a new entry starts at a
    // `\t<identifier>: (` line; continuation lines (multi-line inline types)
    // append to the current entry.
    let mut entries: Vec<String> = Vec::new();
    for line in block.lines() {
        let starts_entry = line
            .strip_prefix('\t')
            .and_then(|rest| rest.split_once(": ("))
            .is_some_and(|(name, _)| {
                !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric())
            });
        if starts_entry {
            entries.push(line.to_string());
        } else if let Some(current) = entries.last_mut() {
            current.push(' ');
            current.push_str(line);
        }
    }
    let mut commands = Vec::new();
    for raw_entry in entries {
        let entry: String = raw_entry.split_whitespace().collect::<Vec<_>>().join(" ");
        let Some((name, rest)) = entry.split_once(": (") else {
            continue;
        };
        if !rest.contains("typedError<") || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let args = rest.split(") =>").next().unwrap_or_default().trim();
        let result = rest
            .split_once("typedError<")
            .and_then(|(_, tail)| tail.split_once(">(__TAURI_INVOKE"))
            .and_then(|(generics, _)| generics.rsplit_once(", LoamError"))
            .map(|(result, _)| result.trim())
            .unwrap_or_default();
        commands.push(serde_json::json!({
            "name": name,
            "args": args,
            "result": result,
            "error": "LoamError",
        }));
    }
    commands.sort_by_key(|c| c["name"].as_str().unwrap_or_default().to_string());

    // Events: the §5.4 channels with their envelope payload types.
    let events = serde_json::json!([
        { "channel": loam_core::ipc::EVENT_CONFLICT, "payload": "EventEnvelope<ConflictPayload>" },
        { "channel": loam_core::ipc::EVENT_FILE_CHANGED, "payload": "EventEnvelope<VaultEvent>" },
        { "channel": loam_core::ipc::EVENT_INDEX_PROGRESS, "payload": "EventEnvelope<IndexProgress>" },
    ]);

    // Exported types, sorted.
    let mut types: Vec<&str> = source
        .lines()
        .filter_map(|line| {
            line.strip_prefix("export type ")
                .and_then(|rest| rest.split([' ', '<', '=']).next())
        })
        .collect();
    types.sort_unstable();

    // Error variants from the LoamError union: every `{ error: "tag" …`.
    let mut errors: Vec<String> = source
        .lines()
        .find(|line| line.starts_with("export type LoamError"))
        .map(|line| {
            line.match_indices("error: \"")
                .filter_map(|(at, _)| line[at + 8..].split('"').next().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    errors.sort();
    errors.dedup();

    serde_json::json!({
        "contract": "loam-ipc",
        "milestone": "M0",
        "transport": "JSON payloads (MessagePack/raw IPC only as a future measured optimization for graph/search)",
        "commands": commands,
        "events": events,
        "errorVariants": errors,
        "types": types,
    })
}

/// AC1 + AC2 + AC4: the manifest lists every command/event/type/error, is
/// deterministic, and any divergence fails with a readable diff.
#[test]
fn manifest_is_complete_deterministic_and_snapshotted() {
    let manifest = build_manifest();
    assert_eq!(manifest, build_manifest(), "deterministic (AC2)");

    // Completeness floor (AC1): all 9 M0 commands, 3 events, error variants.
    assert_eq!(
        manifest["commands"].as_array().expect("commands").len(),
        9,
        "all M0 commands present"
    );
    assert_eq!(manifest["events"].as_array().expect("events").len(), 3);
    let errors = manifest["errorVariants"].as_array().expect("errors");
    assert!(
        errors.iter().any(|e| e == "conflict") && errors.iter().any(|e| e == "unknown-vault"),
        "error variants enumerated: {errors:?}"
    );
    for command in manifest["commands"].as_array().expect("commands") {
        assert!(
            !command["args"].as_str().expect("args").is_empty()
                || command["name"] == "vaultPickAndOpen"
        );
        assert!(!command["result"].as_str().expect("result").is_empty());
    }

    let rendered = serde_json::to_string_pretty(&manifest).expect("serializes") + "\n";
    let path = manifest_path();
    if std::env::var("LOAM_UPDATE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &rendered).expect("write manifest");
    }
    let committed = std::fs::read_to_string(&path)
        .expect("manifest committed — regenerate with LOAM_UPDATE_FIXTURES=1");
    // AC4: mismatches fail with the full readable JSON diff below.
    similar_assert(&committed, &rendered);
}

/// Minimal readable diff on mismatch (line-by-line).
fn similar_assert(committed: &str, generated: &str) {
    if committed == generated {
        return;
    }
    let mut diff = String::new();
    for (index, (old, new)) in committed.lines().zip(generated.lines()).enumerate() {
        if old != new {
            diff.push_str(&format!("line {}:\n  - {old}\n  + {new}\n", index + 1));
        }
    }
    let (old_count, new_count) = (committed.lines().count(), generated.lines().count());
    if old_count != new_count {
        diff.push_str(&format!("line count: {old_count} -> {new_count}\n"));
    }
    panic!(
        "IPC contract manifest diverged (docs/ipc-contract-manifest.json).\n\
         If this change is intentional, follow docs/ipc-contract.md (additions are\n\
         compatible; renames/removals are breaking) and regenerate with\n\
         LOAM_UPDATE_FIXTURES=1.\n\n{diff}"
    );
}
