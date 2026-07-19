//! Tantivy index lifecycle (D6, LOA-67): the `search/` directory under the
//! per-device app-data layout (§5.5) is derived, versioned, and disposable —
//! Markdown files and the SQLite index stay authoritative. Version mismatch
//! or corruption wipes and rebuilds; vault files are never touched.

use std::path::{Path, PathBuf};

use tantivy::schema::{Field, Value};
use tantivy::{Index, IndexWriter, TantivyDocument, Term};

use super::schema::{
    FIELD_BODY, FIELD_HEADINGS, FIELD_PATH, FIELD_PATH_TEXT, FIELD_PROPERTIES, FIELD_TAGS,
    FIELD_TAGS_RAW, FIELD_TITLE, SEARCH_SCHEMA_VERSION, schema,
};
use crate::index::{IndexReader, QueryError};
use crate::parse::PropertyValue;
use crate::vault::note_read;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("search index error: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("failed to prepare the search directory: {0}")]
    Io(#[from] std::io::Error),
    #[error("metadata query failed: {0}")]
    Metadata(#[from] QueryError),
}

/// Why the lifecycle discarded the previous search index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchRebuildCause {
    Missing,
    SchemaVersionChanged,
    Corrupt,
}

/// One note's searchable content, assembled from the SQLite metadata (E04)
/// plus the note body read from the vault.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchDoc {
    pub path: String,
    pub title: String,
    pub headings: Vec<String>,
    pub body: String,
    pub tags: Vec<String>,
    pub properties: Vec<String>,
}

/// The vault search index under `<device>/search/`.
pub struct SearchIndex {
    index: Index,
    writer: IndexWriter,
    fields: Fields,
    dir: PathBuf,
    rebuilding: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

struct Fields {
    path: Field,
    path_text: Field,
    title: Field,
    headings: Field,
    body: Field,
    tags: Field,
    tags_raw: Field,
    properties: Field,
}

const VERSION_FILE: &str = "schema-version";
const INDEX_DIR: &str = "tantivy";
const WRITER_HEAP: usize = 50_000_000;

fn read_version(dir: &Path) -> Option<u32> {
    std::fs::read_to_string(dir.join(VERSION_FILE))
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
}

impl SearchIndex {
    /// Open the search index under `search_dir`, wiping and recreating it
    /// when missing, schema-versioned differently, or corrupt. Returns the
    /// rebuild cause when the caller must re-feed documents.
    pub fn open(search_dir: &Path) -> Result<(Self, Option<SearchRebuildCause>), SearchError> {
        let index_dir = search_dir.join(INDEX_DIR);
        let cause = if !index_dir.exists() {
            Some(SearchRebuildCause::Missing)
        } else if read_version(search_dir) != Some(SEARCH_SCHEMA_VERSION) {
            Some(SearchRebuildCause::SchemaVersionChanged)
        } else {
            None
        };

        if cause.is_none() {
            match Self::open_existing(search_dir, &index_dir) {
                Ok(open) => return Ok((open, None)),
                Err(_) => {
                    // Unreadable index: fall through to a clean rebuild.
                    return Self::create_fresh(search_dir, &index_dir)
                        .map(|s| (s, Some(SearchRebuildCause::Corrupt)));
                }
            }
        }
        Self::create_fresh(search_dir, &index_dir).map(|s| (s, cause))
    }

    fn open_existing(search_dir: &Path, index_dir: &Path) -> Result<Self, SearchError> {
        let index = Index::open_in_dir(index_dir)?;
        Self::assemble(search_dir, index)
    }

    fn create_fresh(search_dir: &Path, index_dir: &Path) -> Result<Self, SearchError> {
        if index_dir.exists() {
            std::fs::remove_dir_all(index_dir)?;
        }
        std::fs::create_dir_all(index_dir)?;
        let index = Index::create_in_dir(index_dir, schema())?;
        std::fs::write(
            search_dir.join(VERSION_FILE),
            format!("{SEARCH_SCHEMA_VERSION}\n"),
        )?;
        Self::assemble(search_dir, index)
    }

    fn assemble(search_dir: &Path, index: Index) -> Result<Self, SearchError> {
        let schema = index.schema();
        let field = |name: &str| schema.get_field(name).expect("schema field");
        let fields = Fields {
            path: field(FIELD_PATH),
            path_text: field(FIELD_PATH_TEXT),
            title: field(FIELD_TITLE),
            headings: field(FIELD_HEADINGS),
            body: field(FIELD_BODY),
            tags: field(FIELD_TAGS),
            tags_raw: field(FIELD_TAGS_RAW),
            properties: field(FIELD_PROPERTIES),
        };
        let writer = index.writer(WRITER_HEAP)?;
        Ok(Self {
            index,
            writer,
            fields,
            dir: search_dir.to_path_buf(),
            rebuilding: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// A cheap, cloneable read handle for concurrent searches. Carries the
    /// rebuild flag so results can state when the index is incomplete.
    pub fn handle(&self) -> super::execute::SearchHandle {
        super::execute::SearchHandle {
            index: self.index.clone(),
            rebuilding: self.rebuilding.clone(),
        }
    }

    /// The search directory this index lives in (always outside the vault).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn tantivy(&self) -> &Index {
        &self.index
    }

    /// Add or replace one note's document. Deletes any previous document for
    /// the path first, so stale terms cannot survive an update.
    pub fn upsert(&mut self, doc: &SearchDoc) -> Result<(), SearchError> {
        self.writer
            .delete_term(Term::from_field_text(self.fields.path, &doc.path));
        let mut document = TantivyDocument::new();
        document.add_text(self.fields.path, &doc.path);
        document.add_text(self.fields.path_text, &doc.path);
        document.add_text(self.fields.title, &doc.title);
        for heading in &doc.headings {
            document.add_text(self.fields.headings, heading);
        }
        document.add_text(self.fields.body, &doc.body);
        for tag in &doc.tags {
            document.add_text(self.fields.tags, tag);
            document.add_text(self.fields.tags_raw, tag);
        }
        for property in &doc.properties {
            document.add_text(self.fields.properties, property);
        }
        self.writer.add_document(document)?;
        Ok(())
    }

    /// Remove one note's document.
    pub fn remove(&mut self, path: &str) -> Result<(), SearchError> {
        self.writer
            .delete_term(Term::from_field_text(self.fields.path, path));
        Ok(())
    }

    /// Rename: re-key the document. The caller supplies the (unchanged)
    /// content as a `SearchDoc` with the new path.
    pub fn rename(&mut self, from: &str, doc: &SearchDoc) -> Result<(), SearchError> {
        self.remove(from)?;
        self.upsert(doc)
    }

    /// Commit pending operations and make them visible to searchers.
    pub fn commit(&mut self) -> Result<(), SearchError> {
        self.writer.commit()?;
        Ok(())
    }

    /// All indexed paths (test/diagnostic helper).
    pub fn indexed_paths(&self) -> Result<Vec<String>, SearchError> {
        use tantivy::collector::DocSetCollector;
        use tantivy::query::AllQuery;
        let reader = self.index.reader()?;
        let searcher = reader.searcher();
        let docs = searcher.search(&AllQuery, &DocSetCollector)?;
        let mut paths = Vec::new();
        for address in docs {
            let doc: TantivyDocument = searcher.doc(address)?;
            if let Some(value) = doc.get_first(self.fields.path).and_then(|v| v.as_str()) {
                paths.push(value.to_string());
            }
        }
        paths.sort();
        Ok(paths)
    }
}

/// Assemble one note's `SearchDoc` from E04 metadata + the vault body.
/// Metadata-only files (>20 MB, §5.6) keep an empty body — file metadata is
/// searchable, oversized content is excluded from FTS.
pub fn search_doc(
    metadata: &IndexReader,
    canonical_root: &Path,
    path: &str,
) -> Result<SearchDoc, SearchError> {
    let title = Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let headings = metadata
        .headings_of(path)?
        .into_iter()
        .map(|h| h.text)
        .collect();
    let tags = metadata.tags_of(path)?;
    let properties = metadata
        .properties_of(path)?
        .into_iter()
        .map(|p| format!("{}: {}", p.key, property_text(&p.value)))
        .collect();
    let body = note_read(canonical_root, path)
        .ok()
        .and_then(|note| note.content)
        .unwrap_or_default();
    Ok(SearchDoc {
        path: path.to_string(),
        title,
        headings,
        body,
        tags,
        properties,
    })
}

fn property_text(value: &PropertyValue) -> String {
    match value {
        PropertyValue::Text(s) | PropertyValue::Date(s) | PropertyValue::Datetime(s) => s.clone(),
        PropertyValue::Number(n) => n.to_string(),
        PropertyValue::Checkbox(b) => b.to_string(),
        PropertyValue::List(items) => items
            .iter()
            .map(property_text)
            .collect::<Vec<_>>()
            .join(", "),
        PropertyValue::Empty => String::new(),
    }
}

/// Full rebuild: feed every file known to the SQLite index. Walks the E04
/// snapshot page by page; commits once at the end.
pub fn rebuild_all(
    search: &mut SearchIndex,
    metadata: &IndexReader,
    canonical_root: &Path,
    mut progress: impl FnMut(u64),
) -> Result<u64, SearchError> {
    search
        .rebuilding
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut run = || -> Result<u64, SearchError> {
        let mut done = 0u64;
        let mut cursor: Option<String> = None;
        loop {
            let page = metadata.files_page(crate::index::MAX_PAGE_SIZE, cursor.as_deref())?;
            let Some(last) = page.last() else { break };
            cursor = Some(last.path.clone());
            for file in &page {
                let doc = search_doc(metadata, canonical_root, &file.path)?;
                search.upsert(&doc)?;
                done += 1;
                progress(done);
            }
        }
        search.commit()?;
        Ok(done)
    };
    let result = run();
    search
        .rebuilding
        .store(false, std::sync::atomic::Ordering::Relaxed);
    result
}
