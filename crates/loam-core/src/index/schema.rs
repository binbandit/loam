//! `index.db` schema v1 (D5, §5.5): a derived, disposable cache of what the
//! parse layer extracts. Files are truth — every row here is rebuildable
//! from the vault, and deleting the database loses nothing.

/// Schema version, stored in SQLite's `user_version` pragma so it is
/// readable on ANY database file without assuming any table exists.
pub const SCHEMA_VERSION: u32 = 1;

/// The v1 DDL: files plus the seven extraction tables, with foreign keys
/// cascading on file deletion and indexes shaped by the known query paths
/// (backlinks by target, tag filters, alias resolution, per-file replace).
pub const SCHEMA_V1: &str = "
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE files (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,   -- NFC vault-relative path
    content_hash TEXT NOT NULL,          -- blake3 hex (E02 ContentHash)
    size         INTEGER NOT NULL,
    modified_ms  INTEGER NOT NULL,
    indexed_ms   INTEGER NOT NULL,
    size_policy  TEXT NOT NULL DEFAULT 'full'
                 CHECK (size_policy IN ('full', 'source-only', 'metadata-only'))
) STRICT;

CREATE TABLE headings (
    id      INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    level   INTEGER NOT NULL,
    text    TEXT NOT NULL,
    start   INTEGER NOT NULL,
    end     INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_headings_file ON headings(file_id);
CREATE INDEX idx_headings_text ON headings(text COLLATE NOCASE);

CREATE TABLE links (
    id       INTEGER PRIMARY KEY,
    file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    target   TEXT NOT NULL,              -- original spelling, never rewritten
    note     TEXT,                       -- wiki component: note part
    heading  TEXT,                       -- wiki component: #Heading
    block    TEXT,                       -- wiki component: #^block
    text     TEXT NOT NULL,
    style    TEXT NOT NULL CHECK (style IN ('markdown', 'wiki')),
    embed    INTEGER NOT NULL DEFAULT 0 CHECK (embed IN (0, 1)),
    start    INTEGER NOT NULL,
    end      INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_links_file ON links(file_id);
CREATE INDEX idx_links_note ON links(note COLLATE NOCASE);
CREATE INDEX idx_links_target ON links(target COLLATE NOCASE);

CREATE TABLE tags (
    id      INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    start   INTEGER NOT NULL,
    end     INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_tags_file ON tags(file_id);
CREATE INDEX idx_tags_name ON tags(name COLLATE NOCASE);

CREATE TABLE properties (
    id         INTEGER PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_type TEXT NOT NULL
               CHECK (value_type IN ('text','number','checkbox','date','datetime','list','empty')),
    value_json TEXT NOT NULL,            -- serialized PropertyValue payload
    start      INTEGER NOT NULL,
    end        INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_properties_file ON properties(file_id);
CREATE INDEX idx_properties_key ON properties(key COLLATE NOCASE);

CREATE TABLE blocks (
    id       INTEGER PRIMARY KEY,
    file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    start    INTEGER NOT NULL,
    end      INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_blocks_file ON blocks(file_id);
CREATE UNIQUE INDEX idx_blocks_file_block ON blocks(file_id, block_id);

CREATE TABLE aliases (
    id      INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    alias   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_aliases_file ON aliases(file_id);
CREATE INDEX idx_aliases_alias ON aliases(alias COLLATE NOCASE);
";

/// Every table the v1 schema must contain — the AC1 checklist.
pub const TABLES: [&str; 8] = [
    "meta",
    "files",
    "headings",
    "links",
    "tags",
    "properties",
    "blocks",
    "aliases",
];
