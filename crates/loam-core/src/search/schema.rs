//! Tantivy schema (D6, §3.6): one document per note. Fields carry query-time
//! boosts title > headings > body > tags; exact-match filters (`tag:`,
//! `path:`, deletion-by-path) use raw STRING fields beside the tokenized
//! ones. The schema is versioned independently of the SQLite index — bump
//! [`SEARCH_SCHEMA_VERSION`] on ANY field change and the lifecycle wipes and
//! rebuilds the derived `search/` directory.

use tantivy::schema::{STORED, STRING, Schema, TEXT};

/// Independent search schema version (AC: schema changes trigger rebuild).
pub const SEARCH_SCHEMA_VERSION: u32 = 1;

/// D6 query-time field boosts: title > headings > body > tags.
pub const TITLE_BOOST: f32 = 4.0;
pub const HEADINGS_BOOST: f32 = 3.0;
pub const BODY_BOOST: f32 = 1.0;
pub const TAGS_BOOST: f32 = 0.5;

/// Field names, single source of truth for schema + queries.
pub const FIELD_PATH: &str = "path";
pub const FIELD_PATH_TEXT: &str = "path_text";
pub const FIELD_TITLE: &str = "title";
pub const FIELD_HEADINGS: &str = "headings";
pub const FIELD_BODY: &str = "body";
pub const FIELD_TAGS: &str = "tags";
pub const FIELD_TAGS_RAW: &str = "tags_raw";
pub const FIELD_PROPERTIES: &str = "properties";

/// Build the v1 schema.
pub fn schema() -> Schema {
    let mut builder = Schema::builder();
    // Raw path: document identity (deletes/renames) and `path:` prefixes.
    builder.add_text_field(FIELD_PATH, STRING | STORED);
    // Tokenized path for fuzzy/full-text `file:` matching.
    builder.add_text_field(FIELD_PATH_TEXT, TEXT);
    builder.add_text_field(FIELD_TITLE, TEXT | STORED);
    builder.add_text_field(FIELD_HEADINGS, TEXT | STORED);
    builder.add_text_field(FIELD_BODY, TEXT | STORED);
    builder.add_text_field(FIELD_TAGS, TEXT);
    // Raw tags for exact `tag:#x` filters (nested names kept whole).
    builder.add_text_field(FIELD_TAGS_RAW, STRING);
    builder.add_text_field(FIELD_PROPERTIES, TEXT | STORED);
    builder.build()
}
