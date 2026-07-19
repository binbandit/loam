//! LOA-54: stable IPC domain types and errors.

use loam_core::ipc::{
    ChangeOrigin, ConflictPayload, EventEnvelope, EventKind, HashHex, IndexProgress, IndexStatus,
    LoamError, NoteDoc, NoteMeta, NoteRef, SizePolicy, VaultCounts, VaultEvent, VaultInfo,
    VaultPath, WriteResult,
};
use loam_core::vault;

fn exemplars() -> serde_json::Value {
    let path = || VaultPath("notes/idea.md".into());
    let hash = || HashHex("ab12cd".into());
    serde_json::json!({
        "vaultInfo": VaultInfo {
            id: "6f2b1e04-9c1c-4f8e-9a2e-3d3f8a1b2c4d".into(),
            name: "My Vault".into(),
            read_only: false,
            transient_identity: false,
            counts: VaultCounts { notes: 3, folders: 1, attachments: 2 },
            index_status: IndexStatus::NotIndexed,
        },
        "noteDoc": NoteDoc {
            path: path(),
            content: Some("# Hi\n".into()),
            hash: hash(),
            meta: NoteMeta {
                size: 5,
                modified_ms: Some(1_752_000_000_000),
                read_only: false,
                size_policy: SizePolicy::Normal,
                read_ms: 2,
            },
        },
        "writeResult": WriteResult { path: path(), hash: hash() },
        "noteRef": NoteRef { path: path(), title: "Idea".into() },
        "eventModified": VaultEvent {
            path: path(),
            kind: EventKind::Modified,
            origin: ChangeOrigin::External,
        },
        "eventRenamed": VaultEvent {
            path: path(),
            kind: EventKind::Renamed { from: VaultPath("old.md".into()) },
            origin: ChangeOrigin::App,
        },
        "indexProgress": IndexProgress { done: 3, total: 9 },
        "envelopedEvent": EventEnvelope {
            seq: 7,
            vault_id: "6f2b1e04-9c1c-4f8e-9a2e-3d3f8a1b2c4d".into(),
            payload: VaultEvent {
                path: path(),
                kind: EventKind::Deleted,
                origin: ChangeOrigin::External,
            },
        },
        "conflict": ConflictPayload {
            path: path(),
            mine: "mine".into(),
            disk: "disk".into(),
            base: Some("base".into()),
            disk_hash: hash(),
        },
        "errors": [
            LoamError::NotFound { path: path() },
            LoamError::Conflict { path: path(), disk_hash: hash() },
            LoamError::Io { kind: "permission-denied".into(), path: Some(path()) },
            LoamError::CorruptIdentity,
        ],
    })
}

/// AC1: every M0 domain type exports to TypeScript through specta. The
/// collection is EXPLICIT (not the global registry) so this list is itself
/// the M0 contract inventory.
#[test]
fn all_domain_types_export_to_typescript() {
    let types = specta::Types::default()
        .register::<VaultPath>()
        .register::<HashHex>()
        .register::<VaultInfo>()
        .register::<VaultCounts>()
        .register::<IndexStatus>()
        .register::<NoteDoc>()
        .register::<NoteMeta>()
        .register::<SizePolicy>()
        .register::<WriteResult>()
        .register::<NoteRef>()
        .register::<VaultEvent>()
        .register::<EventKind>()
        .register::<ChangeOrigin>()
        .register::<IndexProgress>()
        .register::<ConflictPayload>()
        .register::<EventEnvelope<VaultEvent>>()
        .register::<LoamError>();
    let output = specta_typescript::Typescript::default()
        .export(&types, specta_serde::Format)
        .expect("typescript export succeeds");
    for name in [
        "VaultPath",
        "HashHex",
        "VaultInfo",
        "VaultCounts",
        "IndexStatus",
        "NoteDoc",
        "NoteMeta",
        "SizePolicy",
        "WriteResult",
        "NoteRef",
        "VaultEvent",
        "EventKind",
        "ChangeOrigin",
        "IndexProgress",
        "ConflictPayload",
        "EventEnvelope",
        "LoamError",
    ] {
        assert!(
            output.contains(&format!("export type {name}"))
                || output.contains(&format!("export interface {name}")),
            "{name} missing from TypeScript export"
        );
    }
    // The tagged error union carries its stable tags.
    assert!(output.contains("\"outside-vault\""), "{output}");
    assert!(output.contains("\"materialization-required\""));
}

/// AC2: every expected filesystem failure maps to a stable variant.
#[test]
fn expected_failures_map_to_stable_variants() {
    use std::io::{Error as IoError, ErrorKind};

    let note = |error: vault::NoteError| LoamError::from_note_error(error, "notes/x.md");
    assert!(matches!(
        note(vault::NoteError::OutsideVault("/abs/esc".into())),
        LoamError::OutsideVault { .. }
    ));
    assert!(matches!(
        note(vault::NoteError::NotFound("/abs/x".into())),
        LoamError::NotFound { .. }
    ));
    assert!(matches!(
        note(vault::NoteError::NotAFile("/abs/x".into())),
        LoamError::NotAFile { .. }
    ));
    assert!(matches!(
        note(vault::NoteError::NotUtf8("/abs/x".into())),
        LoamError::NotUtf8 { .. }
    ));
    assert!(matches!(
        note(vault::NoteError::MaterializationRequired("/abs/x".into())),
        LoamError::MaterializationRequired { .. }
    ));
    assert!(matches!(
        note(vault::NoteError::Io(IoError::from(
            ErrorKind::PermissionDenied
        ))),
        LoamError::Io { .. }
    ));

    let disk_hash = vault::ContentHash::of(b"disk");
    let conflict = LoamError::from_write_error(
        vault::WriteError::Conflict {
            disk_hash: disk_hash.clone(),
        },
        "notes/x.md",
    );
    let LoamError::Conflict {
        path,
        disk_hash: mapped,
    } = conflict
    else {
        panic!("conflict maps to Conflict");
    };
    assert_eq!(path.0, "notes/x.md");
    assert_eq!(mapped.0, disk_hash.as_str());

    assert!(matches!(
        LoamError::from_write_error(vault::WriteError::AlreadyExists, "x.md"),
        LoamError::AlreadyExists { .. }
    ));
    assert!(matches!(
        LoamError::from_write_error(
            vault::WriteError::Io(IoError::from(ErrorKind::PermissionDenied)),
            "x.md"
        ),
        LoamError::ReadOnly { .. },
    ));

    assert!(matches!(
        LoamError::from_ops_error(
            vault::OpsError::CaseInsensitiveCollision("Note.md".into()),
            "note.md"
        ),
        LoamError::AlreadyExists { .. }
    ));
    assert!(matches!(
        LoamError::from_ops_error(
            vault::OpsError::Trash("x.md".into(), "gio failed".into()),
            "x.md"
        ),
        LoamError::Internal { .. }
    ));
}

/// AC3: serialized errors carry actionable safe fields — vault-relative
/// paths and stable kind strings, never absolute OS paths or backtraces.
#[test]
fn serialized_errors_are_redacted_and_actionable() {
    // Feed ABSOLUTE paths in; the mapped error must expose only the
    // vault-relative path the caller asked about.
    let error = LoamError::from_note_error(
        vault::NoteError::NotFound("/Users/someone/secret-vault/notes/x.md".into()),
        "notes/x.md",
    );
    let json = serde_json::to_string(&error).expect("serializes");
    assert_eq!(
        json, r#"{"error":"not-found","path":"notes/x.md"}"#,
        "tagged, minimal, relative"
    );
    assert!(!json.contains("/Users"), "no absolute paths");
    assert!(!json.contains("secret-vault"), "no vault location leak");

    let io = LoamError::from_note_error(
        vault::NoteError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        "notes/x.md",
    );
    let json = serde_json::to_string(&io).expect("serializes");
    assert!(json.contains("\"kind\":\"permission-denied\""), "{json}");
    assert!(!json.to_lowercase().contains("backtrace"));
    assert!(!json.contains("os error"), "no raw OS error text: {json}");

    // Display strings are human-usable and equally safe.
    assert_eq!(error.to_string(), "not found");
}

/// AC4: path and hash are distinct types — a function typed for one cannot
/// receive the other, even though both serialize as strings.
#[test]
fn path_and_hash_newtypes_cannot_be_confused() {
    fn takes_path(path: &VaultPath) -> &str {
        &path.0
    }
    fn takes_hash(hash: &HashHex) -> &str {
        &hash.0
    }
    let path = VaultPath("notes/x.md".into());
    let hash = HashHex("ab12".into());
    assert_eq!(takes_path(&path), "notes/x.md");
    assert_eq!(takes_hash(&hash), "ab12");
    // takes_path(&hash) / takes_hash(&path) do not compile — the newtypes
    // are the boundary. Serialization stays transparent:
    assert_eq!(
        serde_json::to_string(&path).expect("json"),
        "\"notes/x.md\""
    );
    assert_eq!(serde_json::to_string(&hash).expect("json"), "\"ab12\"");
    // And the conversion from core hashes is explicit.
    let core = vault::ContentHash::of(b"x");
    assert_eq!(HashHex::from(&core).0, core.as_str());
}

/// AC5: the exemplar JSON snapshot is deterministic — identical across
/// serializations and matching the committed snapshot.
#[test]
fn json_snapshots_are_deterministic() {
    let first = serde_json::to_string_pretty(&exemplars()).expect("serializes");
    let second = serde_json::to_string_pretty(&exemplars()).expect("serializes");
    assert_eq!(first, second, "same input, same bytes");

    let snapshot_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots/ipc-shapes.json");
    if std::env::var("LOAM_UPDATE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(snapshot_path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&snapshot_path, first.clone() + "\n").expect("write snapshot");
    }
    // Normalize CRLF: Windows checkouts may rewrite line endings.
    let committed = std::fs::read_to_string(&snapshot_path)
        .expect("snapshot committed — regenerate with LOAM_UPDATE_FIXTURES=1")
        .replace("\r\n", "\n");
    assert_eq!(
        committed.trim_end(),
        first,
        "IPC shapes diverged from the committed snapshot; if intentional, \
         regenerate with LOAM_UPDATE_FIXTURES=1 and follow the LOA-65 contract process"
    );
}
