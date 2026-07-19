//! The `index.db` write handle (D5): bundled rusqlite, WAL, enforced foreign
//! keys. One `IndexDb` is the single writer — it is `Send` but not `Sync`,
//! so ownership naturally pins it to the one writer thread (§5.5 perf note);
//! pooled read connections arrive with the query repositories (LOA-61).

use std::path::Path;

use rusqlite::{Connection, OpenFlags, params};

use super::schema::SCHEMA_V1;
use crate::parse::{ExtractedDoc, LinkStyle, PropertyValue};

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("index database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("failed to prepare the index location: {0}")]
    Io(#[from] std::io::Error),
    #[error("index integrity check failed: {0}")]
    Corrupt(String),
}

/// Version metadata readable from any `index.db`, before migrations run —
/// `user_version` needs no tables, and `meta` is probed defensively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexVersions {
    pub schema: u32,
    /// Parser version recorded at creation; `None` when the meta table is
    /// absent or unreadable (e.g. pre-schema or foreign database).
    pub parser: Option<u32>,
}

/// Read version metadata without assuming any schema (AC5). Never writes.
pub fn read_versions(path: &Path) -> Result<IndexVersions, IndexError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let schema: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let parser = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'parser_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok());
    Ok(IndexVersions { schema, parser })
}

/// The single-writer handle over `index.db`.
pub struct IndexDb {
    conn: Connection,
}

/// File-level metadata accompanying one indexed document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord<'a> {
    /// NFC vault-relative path.
    pub path: &'a str,
    /// blake3 content hash (hex).
    pub content_hash: &'a str,
    pub size: u64,
    pub modified_ms: i64,
    pub indexed_ms: i64,
    /// `full` | `source-only` | `metadata-only` (§5.6 size policy).
    pub size_policy: &'a str,
}

/// The forward migration chain (D5: `rusqlite_migration`). Every future
/// schema change appends an `M::up` here; `to_latest` walks any older
/// database forward and stamps `user_version` with the migration count,
/// which therefore always equals [`SCHEMA_VERSION`].
pub(super) fn migrations() -> rusqlite_migration::Migrations<'static> {
    rusqlite_migration::Migrations::new(vec![rusqlite_migration::M::up(SCHEMA_V1)])
}

impl IndexDb {
    /// Open (creating if needed) the index at `path` — the §5.5 device
    /// location resolved by `DeviceLayout::paths_for`, never inside a vault.
    /// Any older schema is migrated forward; a fresh database gets the full
    /// current schema and version metadata.
    pub fn open(path: &Path) -> Result<Self, IndexError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        migrations()
            .to_latest(&mut conn)
            .map_err(|e| IndexError::Corrupt(format!("migration failed: {e}")))?;
        // rusqlite_migration toggles foreign_keys around migrations; enforce
        // them for the connection's lifetime afterwards.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('parser_version', ?1)",
            params![crate::parse::PARSER_VERSION.to_string()],
        )?;
        Ok(Self { conn })
    }

    /// Replace one file's record and every dependent row in a single
    /// transaction — the write primitive the full and incremental pipelines
    /// (LOA-58/59) orchestrate. Idempotent per (path, extraction).
    pub fn replace_file(
        &mut self,
        record: &FileRecord<'_>,
        doc: &ExtractedDoc,
    ) -> Result<(), IndexError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM files WHERE path = ?1", params![record.path])?;
        tx.execute(
            "INSERT INTO files (path, content_hash, size, modified_ms, indexed_ms, size_policy)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.path,
                record.content_hash,
                record.size as i64,
                record.modified_ms,
                record.indexed_ms,
                record.size_policy,
            ],
        )?;
        let file_id = tx.last_insert_rowid();

        for heading in &doc.headings {
            tx.execute(
                "INSERT INTO headings (file_id, level, text, start, end)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    file_id,
                    heading.level,
                    heading.text,
                    heading.range.start as i64,
                    heading.range.end as i64,
                ],
            )?;
        }
        for link in &doc.links {
            let components = link.components.as_ref();
            tx.execute(
                "INSERT INTO links (file_id, target, note, heading, block, text, style, embed, start, end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    file_id,
                    link.target,
                    components.map(|c| c.note.as_str()),
                    components.and_then(|c| c.heading.as_deref()),
                    components.and_then(|c| c.block.as_deref()),
                    link.text,
                    match link.style {
                        LinkStyle::Markdown => "markdown",
                        LinkStyle::Wiki => "wiki",
                    },
                    link.embed,
                    link.range.start as i64,
                    link.range.end as i64,
                ],
            )?;
        }
        for tag in &doc.tags {
            tx.execute(
                "INSERT INTO tags (file_id, name, start, end) VALUES (?1, ?2, ?3, ?4)",
                params![
                    file_id,
                    tag.name,
                    tag.range.start as i64,
                    tag.range.end as i64
                ],
            )?;
        }
        for block in &doc.blocks {
            tx.execute(
                "INSERT OR IGNORE INTO blocks (file_id, block_id, start, end)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    file_id,
                    block.id,
                    block.range.start as i64,
                    block.range.end as i64
                ],
            )?;
        }
        if let Some(frontmatter) = &doc.frontmatter {
            for property in &frontmatter.properties {
                tx.execute(
                    "INSERT INTO properties (file_id, key, value_type, value_json, start, end)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        file_id,
                        property.key,
                        value_type(&property.value),
                        serde_json::to_string(&property.value).expect("PropertyValue serializes"),
                        property.range.start as i64,
                        property.range.end as i64,
                    ],
                )?;
            }
            for alias in &frontmatter.aliases {
                tx.execute(
                    "INSERT INTO aliases (file_id, alias) VALUES (?1, ?2)",
                    params![file_id, alias],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Rename a file in place, preserving its row id — and therefore every
    /// dependent row's identity (LOA-59 AC3). Returns false when `from` is
    /// not indexed.
    pub fn rename_file(&mut self, from: &str, to: &str) -> Result<bool, IndexError> {
        Ok(self.conn.execute(
            "UPDATE files SET path = ?2 WHERE path = ?1",
            params![from, to],
        )? > 0)
    }

    /// The stored content hash for a path, if indexed — the incremental
    /// dedup check (LOA-59 AC5).
    pub fn stored_hash(&self, path: &str) -> Result<Option<String>, IndexError> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row(
                "SELECT content_hash FROM files WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Remove a file (and, via cascade, every dependent row).
    pub fn remove_file(&mut self, path: &str) -> Result<bool, IndexError> {
        Ok(self
            .conn
            .execute("DELETE FROM files WHERE path = ?1", params![path])?
            > 0)
    }

    /// `PRAGMA integrity_check` + `PRAGMA foreign_key_check` (AC4).
    pub fn check_integrity(&self) -> Result<(), IndexError> {
        let ok: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(IndexError::Corrupt(ok));
        }
        let violations = self
            .conn
            .prepare("PRAGMA foreign_key_check")?
            .query_map([], |_| Ok(()))?
            .count();
        if violations > 0 {
            return Err(IndexError::Corrupt(format!(
                "{violations} foreign key violations"
            )));
        }
        Ok(())
    }
}

fn value_type(value: &PropertyValue) -> &'static str {
    match value {
        PropertyValue::Text(_) => "text",
        PropertyValue::Number(_) => "number",
        PropertyValue::Checkbox(_) => "checkbox",
        PropertyValue::Date(_) => "date",
        PropertyValue::Datetime(_) => "datetime",
        PropertyValue::List(_) => "list",
        PropertyValue::Empty => "empty",
    }
}
