//! Pooled index query repositories (D5, LOA-61): concurrent read access for
//! search, switcher, links, tags, backlinks, and panels — WITHOUT leaking
//! SQL or rusqlite types across the core boundary. Readers open their own
//! read-only WAL connections from a small pool, so they see consistent
//! snapshots and never extend the single-writer critical section.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;

use crate::parse::PropertyValue;

/// Stable query-layer error: no rusqlite types, no SQL fragments.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize)]
#[serde(rename_all = "camelCase", tag = "error")]
pub enum QueryError {
    #[error("the index database is missing or unreadable")]
    Unavailable,
    #[error("index query failed: {detail}")]
    Storage { detail: String },
}

impl From<rusqlite::Error> for QueryError {
    fn from(error: rusqlite::Error) -> Self {
        QueryError::Storage {
            detail: error.to_string(),
        }
    }
}

/// List queries are always paged; limits are capped here.
pub const MAX_PAGE_SIZE: u32 = 500;

/// Switcher/files metadata row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub content_hash: String,
    pub size: u64,
    pub modified_ms: i64,
    pub size_policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingRow {
    pub level: u8,
    pub text: String,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRow {
    pub alias: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRow {
    pub target: String,
    pub note: Option<String>,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub text: String,
    /// `markdown` | `wiki` — mirrors the parse model's LinkStyle.
    pub style: String,
    pub embed: bool,
    pub start: u64,
    pub end: u64,
}

/// One inbound mention inside a source note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkMention {
    pub target: String,
    pub start: u64,
    pub end: u64,
}

/// Backlinks grouped per source note (AC2), sources in path order and
/// mentions in source order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkGroup {
    pub source_path: String,
    pub mentions: Vec<BacklinkMention>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRow {
    pub key: String,
    pub value: PropertyValue,
}

const MAX_IDLE: usize = 4;

/// Read-side handle over `index.db`: a small pool of read-only connections.
/// `Send + Sync`; clone-free — share behind an `Arc` if needed.
pub struct IndexReader {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl IndexReader {
    /// Open the reader for an existing index database.
    pub fn open(path: &Path) -> Result<Self, QueryError> {
        let reader = Self {
            path: path.to_path_buf(),
            idle: Mutex::new(Vec::new()),
        };
        let conn = reader.checkout()?; // fail fast when missing/unreadable
        reader.checkin(conn);
        Ok(reader)
    }

    fn checkout(&self) -> Result<Connection, QueryError> {
        if let Some(conn) = self.idle.lock().expect("pool lock").pop() {
            return Ok(conn);
        }
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| QueryError::Unavailable)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(QueryError::from)?;
        Ok(conn)
    }

    fn checkin(&self, conn: Connection) {
        let mut idle = self.idle.lock().expect("pool lock");
        if idle.len() < MAX_IDLE {
            idle.push(conn);
        }
    }

    fn with_conn<T>(
        &self,
        run: impl FnOnce(&Connection) -> Result<T, QueryError>,
    ) -> Result<T, QueryError> {
        let conn = self.checkout()?;
        let result = run(&conn);
        self.checkin(conn);
        result
    }

    /// Files, path-ordered, keyset-paged: pass the last row's `path` as
    /// `after` to continue. Deterministic; no duplicates or skips.
    pub fn files_page(
        &self,
        limit: u32,
        after: Option<&str>,
    ) -> Result<Vec<FileSummary>, QueryError> {
        let limit = limit.min(MAX_PAGE_SIZE);
        self.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT path, content_hash, size, modified_ms, size_policy FROM files
                 WHERE (?1 IS NULL OR path > ?1) ORDER BY path LIMIT ?2",
            )?;
            let rows = statement.query_map(params![after, limit], |row| {
                Ok(FileSummary {
                    path: row.get(0)?,
                    content_hash: row.get(1)?,
                    size: row.get::<_, i64>(2)? as u64,
                    modified_ms: row.get(3)?,
                    size_policy: row.get(4)?,
                })
            })?;
            rows.collect::<Result<_, _>>().map_err(QueryError::from)
        })
    }

    /// Headings of one note, in document order.
    pub fn headings_of(&self, path: &str) -> Result<Vec<HeadingRow>, QueryError> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT h.level, h.text, h.start, h.end FROM headings h
                 JOIN files f ON f.id = h.file_id WHERE f.path = ?1 ORDER BY h.start",
            )?;
            let rows = statement.query_map(params![path], |row| {
                Ok(HeadingRow {
                    level: row.get::<_, i64>(0)? as u8,
                    text: row.get(1)?,
                    start: row.get::<_, i64>(2)? as u64,
                    end: row.get::<_, i64>(3)? as u64,
                })
            })?;
            rows.collect::<Result<_, _>>().map_err(QueryError::from)
        })
    }

    /// Aliases, ordered by (alias, path), keyset-paged on that pair. The
    /// listing deliberately orders BINARY (stable pagination); per-name
    /// alias LOOKUP (E11 resolution) is what `idx_aliases_alias` (NOCASE)
    /// serves, and the plan test pins that.
    pub fn aliases_page(
        &self,
        limit: u32,
        after: Option<&AliasRow>,
    ) -> Result<Vec<AliasRow>, QueryError> {
        let limit = limit.min(MAX_PAGE_SIZE);
        self.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT a.alias, f.path FROM aliases a
                 JOIN files f ON f.id = a.file_id
                 WHERE (?1 IS NULL OR (a.alias, f.path) > (?1, ?2))
                 ORDER BY a.alias, f.path LIMIT ?3",
            )?;
            let rows = statement.query_map(
                params![
                    after.map(|a| a.alias.as_str()),
                    after.map(|a| a.path.as_str()),
                    limit
                ],
                |row| {
                    Ok(AliasRow {
                        alias: row.get(0)?,
                        path: row.get(1)?,
                    })
                },
            )?;
            rows.collect::<Result<_, _>>().map_err(QueryError::from)
        })
    }

    /// Outgoing links of one note, in source order.
    pub fn links_of(&self, path: &str) -> Result<Vec<LinkRow>, QueryError> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT l.target, l.note, l.heading, l.block, l.text, l.style, l.embed,
                        l.start, l.end
                 FROM links l JOIN files f ON f.id = l.file_id
                 WHERE f.path = ?1 ORDER BY l.start",
            )?;
            let rows = statement.query_map(params![path], map_link_row)?;
            rows.collect::<Result<_, _>>().map_err(QueryError::from)
        })
    }

    /// Inbound mentions of a note name, grouped by source note (path order),
    /// mentions in source order. Matches wiki `note` components and plain
    /// targets case-insensitively; full resolution semantics are E11.
    pub fn backlinks(&self, note_name: &str) -> Result<Vec<BacklinkGroup>, QueryError> {
        self.with_conn(|conn| {
            // UNION of two single-index lookups: the `OR` form makes SQLite
            // fall back to a full `links` scan (caught by the query-plan
            // regression test). UNION also dedups links whose note AND
            // target both equal the name (plain `[[name]]`).
            let mut statement = conn.prepare_cached(
                "SELECT f.path, l.target, l.start, l.end
                 FROM links l JOIN files f ON f.id = l.file_id
                 WHERE l.note = ?1 COLLATE NOCASE
                 UNION
                 SELECT f.path, l.target, l.start, l.end
                 FROM links l JOIN files f ON f.id = l.file_id
                 WHERE l.target = ?1 COLLATE NOCASE
                 ORDER BY 1, 3",
            )?;
            let rows = statement.query_map(params![note_name], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    BacklinkMention {
                        target: row.get(1)?,
                        start: row.get::<_, i64>(2)? as u64,
                        end: row.get::<_, i64>(3)? as u64,
                    },
                ))
            })?;
            let mut groups: Vec<BacklinkGroup> = Vec::new();
            for row in rows {
                let (source_path, mention) = row?;
                match groups.last_mut() {
                    Some(group) if group.source_path == source_path => group.mentions.push(mention),
                    _ => groups.push(BacklinkGroup {
                        source_path,
                        mentions: vec![mention],
                    }),
                }
            }
            Ok(groups)
        })
    }

    /// Vault-wide tags with usage counts, name-ordered (§3.5 tags panel).
    pub fn tags_list(&self) -> Result<Vec<TagCount>, QueryError> {
        self.with_conn(|conn| {
            let mut statement =
                conn.prepare_cached("SELECT name, count(*) FROM tags GROUP BY name ORDER BY name")?;
            let rows = statement.query_map([], |row| {
                Ok(TagCount {
                    name: row.get(0)?,
                    count: row.get::<_, i64>(1)? as u64,
                })
            })?;
            rows.collect::<Result<_, _>>().map_err(QueryError::from)
        })
    }

    /// Typed properties of one note, in frontmatter order.
    pub fn properties_of(&self, path: &str) -> Result<Vec<PropertyRow>, QueryError> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT p.key, p.value_json FROM properties p
                 JOIN files f ON f.id = p.file_id WHERE f.path = ?1 ORDER BY p.start",
            )?;
            let rows = statement.query_map(params![path], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (key, value_json) = row?;
                let value = serde_json::from_str(&value_json).map_err(|e| QueryError::Storage {
                    detail: format!("stored property failed to decode: {e}"),
                })?;
                out.push(PropertyRow { key, value });
            }
            Ok(out)
        })
    }

    /// Distinct property keys with usage counts, key-ordered.
    pub fn property_keys(&self) -> Result<Vec<TagCount>, QueryError> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare_cached("SELECT key, count(*) FROM properties GROUP BY key ORDER BY key")?;
            let rows = statement.query_map([], |row| {
                Ok(TagCount {
                    name: row.get(0)?,
                    count: row.get::<_, i64>(1)? as u64,
                })
            })?;
            rows.collect::<Result<_, _>>().map_err(QueryError::from)
        })
    }
}

fn map_link_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LinkRow> {
    Ok(LinkRow {
        target: row.get(0)?,
        note: row.get(1)?,
        heading: row.get(2)?,
        block: row.get(3)?,
        text: row.get(4)?,
        style: row.get(5)?,
        embed: row.get::<_, i64>(6)? != 0,
        start: row.get::<_, i64>(7)? as u64,
        end: row.get::<_, i64>(8)? as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::db::{FileRecord, IndexDb};
    use crate::parse::parse;

    /// Scope: query-plan regression fixtures — the hot queries must keep
    /// hitting their covering indexes, not table scans.
    #[test]
    fn hot_queries_use_their_indexes() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("index.db");
        let mut db = IndexDb::open(&path).expect("open");
        db.replace_file(
            &FileRecord {
                path: "a.md",
                content_hash: "h",
                size: 1,
                modified_ms: 0,
                indexed_ms: 0,
                size_policy: "full",
            },
            &parse("# A\n\n[[B]] #t\n"),
        )
        .expect("seed");

        let conn = Connection::open(&path).expect("open");
        let plan = |sql: &str| -> String {
            let mut statement = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .expect("prepare");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))
                .expect("plan");
            rows.map(|r| r.expect("row")).collect::<Vec<_>>().join("; ")
        };

        let backlinks = plan(
            "SELECT f.path, l.target, l.start, l.end \
             FROM links l JOIN files f ON f.id = l.file_id \
             WHERE l.note = 'B' COLLATE NOCASE \
             UNION \
             SELECT f.path, l.target, l.start, l.end \
             FROM links l JOIN files f ON f.id = l.file_id \
             WHERE l.target = 'B' COLLATE NOCASE \
             ORDER BY 1, 3",
        );
        assert!(
            backlinks.contains("idx_links_note") && backlinks.contains("idx_links_target"),
            "each backlink branch must use its link index: {backlinks}"
        );
        assert!(
            !backlinks.contains("SCAN l"),
            "no full links scan: {backlinks}"
        );

        let files = plan("SELECT path FROM files WHERE path > 'a' ORDER BY path LIMIT 10");
        assert!(
            files.contains("sqlite_autoindex_files_1") || files.contains("USING INDEX"),
            "files paging must use the unique path index: {files}"
        );

        let alias_lookup = plan(
            "SELECT f.path FROM aliases a JOIN files f ON f.id = a.file_id \
             WHERE a.alias = 'A' COLLATE NOCASE",
        );
        assert!(
            alias_lookup.contains("idx_aliases_alias"),
            "alias resolution must use idx_aliases_alias: {alias_lookup}"
        );

        let tag_lookup = plan("SELECT count(*) FROM tags WHERE name = 't' COLLATE NOCASE");
        assert!(
            tag_lookup.contains("idx_tags_name"),
            "tag filter must use idx_tags_name: {tag_lookup}"
        );

        let headings = plan(
            "SELECT h.text FROM headings h JOIN files f ON f.id = h.file_id \
             WHERE f.path = 'a.md' ORDER BY h.start",
        );
        assert!(
            headings.contains("idx_headings_file"),
            "headings lookup must use idx_headings_file: {headings}"
        );
    }
}
