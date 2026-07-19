//! The disposable SQLite index (D5, §5.5): a derived cache of the parse
//! layer's extractions, stored per device via `vault::DeviceLayout` — never
//! inside the vault. Files are truth; this database can be deleted at any
//! time and rebuilt byte-for-byte from the vault.

mod db;
mod dump;
mod incremental;
mod pipeline;
mod recovery;
mod repo;
mod schema;

pub use db::{FileRecord, IndexDb, IndexError, IndexVersions, read_versions};
pub use dump::logical_dump;
pub use incremental::{ReindexOutcome, Reindexer};
pub use pipeline::{FileIssue, RebuildError, RebuildReport, rebuild_full};
pub use recovery::{
    IndexProgress, OpenOutcome, RebuildSession, RecoveryCause, RecoveryDiagnostic,
    open_with_recovery,
};
pub use repo::{
    AliasRow, BacklinkGroup, BacklinkMention, FileSummary, HeadingRow, IndexReader, LinkRow,
    MAX_PAGE_SIZE, PropertyRow, QueryError, TagCount,
};
pub use schema::{SCHEMA_VERSION, TABLES};
