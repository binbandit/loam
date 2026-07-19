//! Normalized logical dumps (§5.12, LOA-62): the canonical text form of an
//! index used by the determinism gates. Every logical indexed row appears;
//! nondeterministic metadata does not — row ids (insert-order artifacts) and
//! `indexed_ms` (wall clock) are omitted, and every table is emitted in a
//! stable order keyed by content.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use super::db::IndexError;

/// Dump every logical row of the index at `path` as ordered lines.
/// Two indexes with equal dumps are logically identical.
pub fn logical_dump(path: &Path) -> Result<Vec<String>, IndexError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut out = Vec::new();
    let queries: [(&str, &str); 7] = [
        (
            "files",
            "SELECT path, content_hash, size, modified_ms, size_policy
             FROM files ORDER BY path",
        ),
        (
            "headings",
            "SELECT f.path, h.level, h.text, h.start, h.end
             FROM headings h JOIN files f ON f.id = h.file_id
             ORDER BY f.path, h.start, h.end",
        ),
        (
            "links",
            "SELECT f.path, l.target, l.note, l.heading, l.block, l.text, l.style, l.embed,
                    l.start, l.end
             FROM links l JOIN files f ON f.id = l.file_id
             ORDER BY f.path, l.start, l.end, l.target",
        ),
        (
            "tags",
            "SELECT f.path, t.name, t.start, t.end
             FROM tags t JOIN files f ON f.id = t.file_id
             ORDER BY f.path, t.start, t.end",
        ),
        (
            "properties",
            "SELECT f.path, p.key, p.value_type, p.value_json, p.start, p.end
             FROM properties p JOIN files f ON f.id = p.file_id
             ORDER BY f.path, p.start, p.key",
        ),
        (
            "blocks",
            "SELECT f.path, b.block_id, b.start, b.end
             FROM blocks b JOIN files f ON f.id = b.file_id
             ORDER BY f.path, b.start, b.block_id",
        ),
        (
            "aliases",
            "SELECT f.path, a.alias
             FROM aliases a JOIN files f ON f.id = a.file_id
             ORDER BY f.path, a.alias",
        ),
    ];
    for (table, sql) in queries {
        let mut statement = conn.prepare(sql)?;
        let columns = statement.column_count();
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let mut fields = Vec::with_capacity(columns);
            for index in 0..columns {
                fields.push(format!(
                    "{:?}",
                    row.get::<_, rusqlite::types::Value>(index)?
                ));
            }
            out.push(format!("{table}|{}", fields.join("|")));
        }
    }
    Ok(out)
}
