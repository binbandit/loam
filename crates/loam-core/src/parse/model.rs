//! The shared extracted document model (D4): what index, search, graph, and
//! the future Reading-view binding all consume. Serializable with camelCase
//! field names so it can cross the Tauri/WASM boundary unchanged.

use serde::{Deserialize, Serialize};

/// Byte range into the ORIGINAL source text (UTF-8 offsets, end-exclusive).
/// Ranges are stable: parsing never rewrites the source, so a range remains
/// valid for the exact text that produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start: usize,
    pub end: usize,
}

/// A heading with its rendered text and location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingRef {
    pub level: u8,
    pub text: String,
    pub range: SourceRange,
}

/// How a link was written in the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkStyle {
    /// `[text](target)` or autolink.
    Markdown,
    /// `[[target]]` / `[[target|text]]`.
    Wiki,
}

/// Parsed components of a wikilink target, alongside the untouched original
/// spelling in [`LinkRef::target`]: `[[Note#Heading]]`, `[[Note#^block]]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiComponents {
    /// Note part before any fragment (may be empty for `[[#Heading]]`).
    pub note: String,
    /// `#Heading` fragment, without the `#`.
    pub heading: Option<String>,
    /// `#^block` fragment, without the `#^`.
    pub block: Option<String>,
}

/// A link occurrence: target as written (resolution is the index's job).
///
/// Embeds (`![[Note]]`, `![alt](img.png)`) are links with `embed: true` —
/// extraction records the reference only and never recurses into the target,
/// so the representation is cycle-safe by construction (recursion and its
/// depth limit live in the renderer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    pub target: String,
    pub text: String,
    pub style: LinkStyle,
    pub embed: bool,
    /// Present for wiki-style links: target split into note/heading/block.
    pub components: Option<WikiComponents>,
    pub range: SourceRange,
}

/// A `#tag` occurrence. Populated by the tag extractor (LOA-40); the model
/// carries the shape from day one so consumers never migrate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    /// Tag text without the leading `#`, nested segments included (`a/b`).
    pub name: String,
    pub range: SourceRange,
}

/// A `^block-id` anchor. Populated in LOA-51.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    pub id: String,
    pub range: SourceRange,
}

/// Kinds of syntax spans the editor and Reading view decorate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum SpanKind {
    Heading {
        level: u8,
    },
    Emphasis,
    Strong,
    Strikethrough,
    InlineCode,
    CodeBlock {
        language: Option<String>,
    },
    /// `depth` is 0-based nesting (a quote inside a quote has depth 1);
    /// combined with range containment it reconstructs the parent tree.
    Blockquote {
        depth: u8,
    },
    /// `> [!type] Title` callout (§3.3). `callout_type` is normalized
    /// (lowercased, aliases resolved); `custom` marks types outside the P0
    /// set, which render with a default icon and type-derived color.
    Callout {
        callout_type: String,
        title: Option<String>,
        fold: Option<CalloutFold>,
        custom: bool,
        depth: u8,
    },
    /// `==highlighted==` text, delimiters included.
    Highlight,
    /// `%%hidden%%` comment — hidden at render time only, NEVER removed
    /// from source; index-relevant items inside it are not extracted.
    Comment,
    ListItem {
        depth: u8,
    },
    Task {
        checked: bool,
        depth: u8,
    },
    Link,
    Wikilink,
    /// `![[...]]` or `![alt](file)` embed.
    Embed,
    /// `#tag` occurrence.
    Tag,
    /// ` ^block-id` suffix.
    BlockId,
    Footnote,
    Frontmatter,
    Table,
    Math,
}

/// Callout fold marker: `[!note]-` starts folded, `[!note]+` explicitly
/// expanded; absence means the default (expanded, not foldable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalloutFold {
    Folded,
    Expanded,
}

/// A decorated region of the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSpan {
    #[serde(flatten)]
    pub kind: SpanKind,
    pub range: SourceRange,
}

/// Diagnostic severity. Parsing never fails — the worst malformed input can
/// do is produce warnings alongside a best-effort model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Warning,
}

/// A structured parse diagnostic. The source is NEVER altered; diagnostics
/// point at it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    /// Stable machine-readable code, e.g. `empty-link-target`.
    pub code: String,
    pub message: String,
    pub range: SourceRange,
}

/// A typed frontmatter property value (§3.7: text, list, number, checkbox,
/// date, datetime). Values that fit none of these (nested maps, exotic YAML)
/// degrade to [`PropertyValue::Text`] — never to data loss.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "value")]
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Checkbox(bool),
    /// `YYYY-MM-DD`, kept as written.
    Date(String),
    /// ISO-8601-compatible datetime, kept as written.
    Datetime(String),
    List(Vec<PropertyValue>),
    Empty,
}

/// One top-level frontmatter property. `range` covers the `key: …` lines in
/// the ORIGINAL source, so the properties UI can jump to and edit in place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Property {
    pub key: String,
    pub value: PropertyValue,
    pub range: SourceRange,
}

/// Parsed leading YAML frontmatter. `tags` and `aliases` are the §3.7
/// reserved keys, surfaced separately for the tag index and link resolution;
/// they also remain in `properties` untouched.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frontmatter {
    pub properties: Vec<Property>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
}

/// Everything extracted from one document in a single parse.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedDoc {
    pub headings: Vec<HeadingRef>,
    pub links: Vec<LinkRef>,
    pub tags: Vec<TagRef>,
    pub blocks: Vec<BlockRef>,
    pub spans: Vec<SyntaxSpan>,
    pub diagnostics: Vec<Diagnostic>,
    /// Typed view of the leading YAML frontmatter; `None` when absent or
    /// unparseable (see `raw_frontmatter` + diagnostics for those bytes).
    pub frontmatter: Option<Frontmatter>,
    /// Raw frontmatter block exactly as written (delimiters included) —
    /// preserved even (especially) when the YAML fails to parse.
    pub raw_frontmatter: Option<String>,
}
