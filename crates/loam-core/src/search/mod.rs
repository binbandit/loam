//! Full-text search (D6, §3.6): tantivy lifecycle over the per-device
//! `search/` directory. Derived and disposable — Markdown files and the
//! SQLite index remain authoritative; anything here can be wiped and
//! rebuilt without loss.

mod execute;
mod frecency;
mod lifecycle;
mod query;
mod schema;
mod session;
mod switcher;

pub use frecency::{Frecency, FrecencyError, HALF_LIFE_MS, MAX_BOOST, MAX_WEIGHT, RecentNote};

pub use session::{GenerationHandle, SwitchBatch, SwitchTiming, SwitcherSession};

pub use switcher::{
    ALIAS_MATCH_BOOST, HEADING_MATCH_BOOST, MatchField, PATH_MATCH_BOOST, SwitchHit, SwitchRecord,
    Switcher, SwitcherError, TITLE_MATCH_BOOST,
};

pub use execute::{
    ExecuteError, HighlightRange, MAX_SEARCH_LIMIT, SearchHandle, SearchHit, SearchPage,
    SearchStatus, SnippetLine,
};

pub use lifecycle::{
    SearchDoc, SearchError, SearchIndex, SearchRebuildCause, rebuild_all, search_doc,
};
pub use query::{
    CompileError, FilterField, ParsedQuery, QueryDiagnostic, QueryNode, QuerySpan, compile_query,
    parse_query,
};
pub use schema::{
    BODY_BOOST, HEADINGS_BOOST, SEARCH_SCHEMA_VERSION, TAGS_BOOST, TITLE_BOOST, schema,
};
