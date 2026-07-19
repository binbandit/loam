//! LOA-63: the generated TypeScript client is committed and drift-checked.
//! Regenerate with:
//! `LOAM_UPDATE_FIXTURES=1 cargo test -p loam-desktop --test bindings_drift`

use std::path::PathBuf;

fn committed_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/ipc-client/src/generated/bindings.ts")
}

fn generate() -> String {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("bindings.ts");
    loam_desktop::export_builder()
        .export(specta_typescript::Typescript::default(), &path)
        .expect("typescript export succeeds");
    std::fs::read_to_string(&path).expect("generated output readable")
}

/// AC1 (+AC2 by construction): a clean generation matches the committed file
/// byte-for-byte — ANY Rust signature change shows up as an intentional
/// TypeScript diff here.
#[test]
fn generation_produces_no_diff() {
    let generated = generate();
    let committed_file = committed_path();
    if std::env::var("LOAM_UPDATE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(committed_file.parent().expect("parent")).expect("mkdir");
        std::fs::write(&committed_file, &generated).expect("write bindings");
    }
    // Normalize CRLF: Windows checkouts may rewrite line endings.
    let committed = std::fs::read_to_string(&committed_file)
        .expect("bindings.ts committed — regenerate with LOAM_UPDATE_FIXTURES=1")
        .replace("\r\n", "\n");
    assert_eq!(
        committed, generated,
        "generated TypeScript client diverged from packages/ipc-client/src/generated/bindings.ts; \
         regenerate with LOAM_UPDATE_FIXTURES=1 and commit the intentional diff"
    );
}

/// Generation is deterministic (same output twice) and the current command
/// surface is present — a signature change moves these anchors.
#[test]
fn generation_is_deterministic_with_expected_surface() {
    let first = generate();
    let second = generate();
    assert_eq!(first, second, "deterministic export");

    for anchor in [
        "vaultOpen",
        "vaultPickAndOpen",
        "noteRead",
        "noteWrite",
        "noteCreate",
        "folderCreate",
        "noteRename",
        "noteDuplicate",
        "noteTrash",
        "baseHash",
        "LoamError",
        "EventEnvelope",
    ] {
        assert!(first.contains(anchor), "{anchor} missing from bindings");
    }
}

/// AC4: no machine-specific absolute paths leak into the generated output.
#[test]
fn generated_output_has_no_absolute_paths() {
    let generated = generate();
    for marker in ["/Users/", "C:\\", "/home/", "\\\\?\\"] {
        assert!(
            !generated.contains(marker),
            "machine path {marker:?} leaked into bindings"
        );
    }
}
