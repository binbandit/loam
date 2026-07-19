//! The stable IPC contract (§5.4, LOA-54): the serializable DTOs and error
//! enum every command returns, annotated for specta so the TypeScript client
//! (LOA-63) and the browser mock (LOA-64) consume the exact same shapes.
//!
//! This module is a COMPATIBILITY BOUNDARY: internal core types may evolve,
//! but changes here follow the documented contract process (LOA-65).
//! Payloads are JSON; every command returns `Result<T, LoamError>`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::vault;

// ─── Path & hash newtypes (AC4: impossible to confuse) ──────────────────────

/// NFC vault-relative path, forward slashes. NEVER an absolute OS path —
/// absolute paths do not cross the IPC boundary (§5.4 privacy note).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct VaultPath(pub String);

impl std::fmt::Display for VaultPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// blake3 content hash, lowercase hex. Distinct from [`VaultPath`] at the
/// type level: a hash can never be passed where a path is expected.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct HashHex(pub String);

impl From<&vault::ContentHash> for HashHex {
    fn from(hash: &vault::ContentHash) -> Self {
        Self(hash.as_str().to_string())
    }
}

// ─── Domain DTOs ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexStatus {
    NotIndexed,
    Indexing,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultCounts {
    pub notes: u32,
    pub folders: u32,
    pub attachments: u32,
}

/// `vault_open` result (§5.4). `root` is the vault's DISPLAY name — the
/// folder name only, never the absolute OS path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub id: String,
    pub name: String,
    pub read_only: bool,
    pub transient_identity: bool,
    pub counts: VaultCounts,
    pub index_status: IndexStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SizePolicy {
    Normal,
    SourceOnly,
    MetadataOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_ms: Option<u64>,
    pub read_only: bool,
    pub size_policy: SizePolicy,
    #[specta(type = specta_typescript::Number)]
    pub read_ms: u64,
}

/// `note_read` result (§5.4): content, hash, meta. `content` is None under
/// the metadata-only size policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteDoc {
    pub path: VaultPath,
    pub content: Option<String>,
    pub hash: HashHex,
    pub meta: NoteMeta,
}

/// `note_write` success payload: the new content hash to use as the next
/// `base_hash`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: VaultPath,
    pub hash: HashHex,
}

/// A reference to a note (creation results, listings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub path: VaultPath,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeOrigin {
    App,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum EventKind {
    Created,
    Modified,
    Renamed { from: VaultPath },
    Deleted,
}

/// `vault://file-changed` payload (§5.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    pub path: VaultPath,
    #[serde(flatten)]
    pub kind: EventKind,
    pub origin: ChangeOrigin,
}

impl From<&vault::VaultInfo> for VaultInfo {
    fn from(info: &vault::VaultInfo) -> Self {
        Self {
            id: info.id.to_string(),
            // Display name only — the absolute root never crosses IPC.
            name: info
                .root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            read_only: info.read_only,
            transient_identity: info.transient_identity,
            counts: VaultCounts {
                notes: info.counts.notes as u32,
                folders: info.counts.folders as u32,
                attachments: info.counts.attachments as u32,
            },
            index_status: match info.index_status {
                vault::IndexStatus::NotIndexed => IndexStatus::NotIndexed,
            },
        }
    }
}

impl From<vault::NoteDoc> for NoteDoc {
    fn from(note: vault::NoteDoc) -> Self {
        Self {
            path: VaultPath(note.relative_path),
            content: note.content,
            hash: HashHex(note.hash.as_str().to_string()),
            meta: NoteMeta {
                size: note.meta.size,
                modified_ms: note.meta.modified_ms,
                read_only: note.meta.read_only,
                size_policy: match note.meta.size_policy {
                    vault::SizePolicy::Normal => SizePolicy::Normal,
                    vault::SizePolicy::SourceOnly => SizePolicy::SourceOnly,
                    vault::SizePolicy::MetadataOnly => SizePolicy::MetadataOnly,
                },
                read_ms: note.meta.read_ms as u64,
            },
        }
    }
}

impl From<vault::VaultEvent> for VaultEvent {
    fn from(event: vault::VaultEvent) -> Self {
        Self {
            path: VaultPath(event.path),
            kind: match event.kind {
                vault::EventKind::Created => EventKind::Created,
                vault::EventKind::Modified => EventKind::Modified,
                vault::EventKind::Renamed { from } => EventKind::Renamed {
                    from: VaultPath(from),
                },
                vault::EventKind::Deleted => EventKind::Deleted,
            },
            origin: match event.origin {
                vault::ChangeOrigin::App => ChangeOrigin::App,
                vault::ChangeOrigin::External => ChangeOrigin::External,
            },
        }
    }
}

/// `vault://index-progress` payload (§5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    #[specta(type = specta_typescript::Number)]
    pub done: u64,
    #[specta(type = specta_typescript::Number)]
    pub total: u64,
}

/// `vault://conflict` payload: buffer, disk, and common-base content for the
/// §5.6 merge banner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPayload {
    pub path: VaultPath,
    pub mine: String,
    pub disk: String,
    pub base: Option<String>,
    pub disk_hash: HashHex,
}

// ─── Event channel names & envelope ─────────────────────────────────────────

/// §5.4 event channels. The TypeScript client subscribes by these exact
/// names; payloads arrive wrapped in [`EventEnvelope`].
pub const EVENT_FILE_CHANGED: &str = "vault://file-changed";
pub const EVENT_INDEX_PROGRESS: &str = "vault://index-progress";
pub const EVENT_CONFLICT: &str = "vault://conflict";

/// Wire envelope for every vault event: a per-vault monotonic sequence
/// number (ordering diagnostics — gaps or regressions indicate a bug) and
/// the originating vault id (defense-in-depth beside per-window delivery).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope<T> {
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    pub vault_id: String,
    pub payload: T,
}

// ─── The stable error enum ──────────────────────────────────────────────────

/// Every IPC command returns `Result<T, LoamError>`. Tagged serialization
/// (`{"error": "...", ...fields}`) with STABLE kebab-case tags — additions
/// are compatible, renames are breaking (LOA-65 process). Fields carry only
/// actionable, safe data: vault-relative paths and error KIND text — never
/// absolute OS paths, never backtraces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(
    rename_all = "kebab-case",
    tag = "error",
    rename_all_fields = "camelCase"
)]
pub enum LoamError {
    #[error("path resolves outside the vault")]
    OutsideVault { path: VaultPath },
    #[error("not found")]
    NotFound { path: VaultPath },
    #[error("not a file")]
    NotAFile { path: VaultPath },
    #[error("not valid UTF-8")]
    NotUtf8 { path: VaultPath },
    #[error("cloud placeholder must be materialized before reading")]
    MaterializationRequired { path: VaultPath },
    #[error("write conflict: disk changed since base hash")]
    Conflict { path: VaultPath, disk_hash: HashHex },
    #[error("target already exists")]
    AlreadyExists { path: VaultPath },
    #[error("vault or file is read-only")]
    ReadOnly { path: VaultPath },
    #[error("vault identity is corrupt")]
    CorruptIdentity,
    #[error("folder is not usable as a vault")]
    NotAVault,
    #[error("no open vault with this id")]
    UnknownVault { id: String },
    #[error("filesystem error: {kind}")]
    Io {
        /// `std::io::ErrorKind` as a stable string (e.g. `permission-denied`)
        /// — actionable without leaking OS-level detail.
        kind: String,
        path: Option<VaultPath>,
    },
    #[error("internal error: {detail}")]
    Internal { detail: String },
}

/// Map an io::ErrorKind to its stable kebab-case string.
fn io_kind(kind: std::io::ErrorKind) -> String {
    format!("{kind:?}")
        .chars()
        .flat_map(|c| {
            if c.is_uppercase() {
                vec!['-', c.to_ascii_lowercase()]
            } else {
                vec![c]
            }
        })
        .collect::<String>()
        .trim_start_matches('-')
        .to_string()
}

impl LoamError {
    /// Map a note-read failure (LOA-25) with the vault-relative path the
    /// caller asked for.
    pub fn from_note_error(error: vault::NoteError, requested: &str) -> Self {
        let path = VaultPath(requested.to_string());
        match error {
            vault::NoteError::OutsideVault(_) => LoamError::OutsideVault { path },
            vault::NoteError::NotFound(_) => LoamError::NotFound { path },
            vault::NoteError::NotAFile(_) => LoamError::NotAFile { path },
            vault::NoteError::NotUtf8(_) => LoamError::NotUtf8 { path },
            vault::NoteError::MaterializationRequired(_) => {
                LoamError::MaterializationRequired { path }
            }
            vault::NoteError::Io(io) => LoamError::Io {
                kind: io_kind(io.kind()),
                path: Some(path),
            },
        }
    }

    /// Map a write failure (LOA-28).
    pub fn from_write_error(error: vault::WriteError, requested: &str) -> Self {
        let path = VaultPath(requested.to_string());
        match error {
            vault::WriteError::Conflict { disk_hash } => LoamError::Conflict {
                path,
                disk_hash: HashHex(disk_hash.as_str().to_string()),
            },
            vault::WriteError::AlreadyExists => LoamError::AlreadyExists { path },
            vault::WriteError::Path(note) => Self::from_note_error(note, requested),
            vault::WriteError::Io(io) => {
                if io.kind() == std::io::ErrorKind::PermissionDenied {
                    LoamError::ReadOnly { path }
                } else {
                    LoamError::Io {
                        kind: io_kind(io.kind()),
                        path: Some(path),
                    }
                }
            }
        }
    }

    /// Map a note/folder operation failure (LOA-30).
    pub fn from_ops_error(error: vault::OpsError, requested: &str) -> Self {
        let path = VaultPath(requested.to_string());
        match error {
            vault::OpsError::CaseInsensitiveCollision(_)
            | vault::OpsError::DestinationExists(_) => LoamError::AlreadyExists { path },
            vault::OpsError::Path(note) => Self::from_note_error(note, requested),
            vault::OpsError::Trash(_, detail) => LoamError::Internal {
                detail: format!("trash failed: {detail}"),
            },
            vault::OpsError::Io(io) => LoamError::Io {
                kind: io_kind(io.kind()),
                path: Some(path),
            },
        }
    }
}
