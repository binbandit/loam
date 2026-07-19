//! Vault identity and per-device data layout (LOA-22, §5.5).
//!
//! The vault's files are the only truth. Loam writes exactly one file into a
//! vault unprompted — `.loam/vault.json`, and only after the user explicitly
//! confirms "use this folder". Everything disposable (index, search, workspace
//! layout, history, graph cache) lives per device under the OS app-data
//! directory, keyed by vault id, and must never be placed inside the vault.

mod cloud;
mod conflict;
mod identity;
mod layout;
mod note;
mod open;
mod ops;
mod paths;
mod tree;
mod watch;
mod writer;

pub use cloud::{CloudAdapter, CloudError, MaterializeProgress, OsCloudAdapter};
pub use conflict::{
    ChangeDecision, ConflictError, ConflictPayload, Resolution, ResolutionOutcome, SessionTracker,
};
pub use identity::{Confirmation, IdentityError, VaultId, VaultIdentity};
pub use layout::{DeviceLayout, DevicePaths, LayoutError};
pub use note::{
    ContentHash, NoteDoc, NoteError, NoteMeta, SizePolicy, note_read, placeholder, resolve_in_vault,
};
pub use open::{IndexStatus, OpenError, Vault, VaultCounts, VaultInfo, vault_open};
pub use ops::{
    OpsError, OsTrash, TrashProvider, create_folder, create_note, delete_to_trash, duplicate,
    rename,
};
pub use paths::{
    PathError, VaultRelPath, WINDOWS_MAX_PATH, extended_length_string, to_extended_length,
};
pub use tree::{EntryKind, TreeEntry, TreeError, VaultTree, enumerate};
pub use watch::{
    AppWriteRegistry, Backend, DEBOUNCE, EventKind, POLL_INTERVAL, RawEvent, VaultEvent,
    VaultWatcher, WatchError, classify, is_ignorable_path, normalize, start_watching,
};
pub use writer::{
    ChangeKind, ChangeOrigin, EventSink, FileChanged, NullSink, TEMP_SUFFIX, WriteError,
    WriteResult, clean_stale_temps, note_write,
};
