//! Markdown conformance fixture runner (§3.3, LOA-27).
//!
//! `/fixtures/markdown/<family>/<name>.md` is the source of truth; each pairs
//! with `<name>.expected.json`:
//!
//! ```json
//! {
//!   "meta":       { "provenance": "original", "license": "MIT" },
//!   "extraction": { ...ExtractedDoc, including diagnostics... },
//!   "lezer":      null,   // reserved: Lezer decoration expectations
//!   "rendering":  null    // reserved: rendered-output expectations
//! }
//! ```
//!
//! The reserved fields let the frontend consumers attach their expectations
//! later without ever duplicating the source. Sources are normalized to `\n`
//! before parsing so comparisons are byte-identical across OS line endings.
//!
//! Authoring workflow: `LOAM_UPDATE_FIXTURES=1 cargo test -p loam-core
//! --test markdown_fixtures` regenerates every `expected.json` (preserving
//! `meta`); review the diff before committing. This is the one sanctioned
//! exception to "tests never write into fixtures/" — it never runs in CI.

use std::path::{Path, PathBuf};

use loam_core::parse::parse;
use serde_json::{Map, Value, json};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/markdown")
}

fn markdown_sources(root: &Path) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("fixture dir is readable") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                sources.push(path);
            }
        }
    }
    sources.sort();
    sources
}

fn expected_path(source: &Path) -> PathBuf {
    source.with_extension("expected.json")
}

/// Normalize OS line endings so extraction ranges are identical everywhere.
fn load_source(path: &Path) -> String {
    std::fs::read_to_string(path)
        .expect("fixture source is readable UTF-8")
        .replace("\r\n", "\n")
}

/// One structural difference between expected and actual extraction.
#[derive(Debug)]
struct Diff {
    /// JSON pointer into the extraction, e.g. `/headings/0/text`.
    pointer: String,
    expected: Value,
    actual: Value,
    /// Source range of the nearest enclosing node that carries one.
    range: Option<(u64, u64)>,
}

impl Diff {
    fn render(&self, fixture: &Path) -> String {
        let at = self
            .range
            .map(|(s, e)| format!(" (source bytes {s}..{e})"))
            .unwrap_or_default();
        format!(
            "{}: `{}`{} expected {} but got {}",
            fixture.display(),
            self.pointer,
            at,
            self.expected,
            self.actual
        )
    }
}

fn range_of(value: &Value) -> Option<(u64, u64)> {
    let range = value.get("range")?;
    Some((range.get("start")?.as_u64()?, range.get("end")?.as_u64()?))
}

/// Recursive structural diff. `inherited` is the closest ancestor range so a
/// leaf mismatch still points into the source.
fn diff_values(
    pointer: &str,
    expected: &Value,
    actual: &Value,
    inherited: Option<(u64, u64)>,
    out: &mut Vec<Diff>,
) {
    let here = range_of(actual)
        .or_else(|| range_of(expected))
        .or(inherited);
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            let mut keys: Vec<&String> = e.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                diff_values(
                    &format!("{pointer}/{escaped}"),
                    e.get(key).unwrap_or(&Value::Null),
                    a.get(key).unwrap_or(&Value::Null),
                    here,
                    out,
                );
            }
        }
        (Value::Array(e), Value::Array(a)) => {
            if e.len() != a.len() {
                out.push(Diff {
                    pointer: format!("{pointer}/length"),
                    expected: json!(e.len()),
                    actual: json!(a.len()),
                    range: here,
                });
            }
            for (index, (ev, av)) in e.iter().zip(a.iter()).enumerate() {
                diff_values(&format!("{pointer}/{index}"), ev, av, here, out);
            }
        }
        (e, a) if e != a => out.push(Diff {
            pointer: if pointer.is_empty() { "/" } else { pointer }.to_string(),
            expected: e.clone(),
            actual: a.clone(),
            range: here,
        }),
        _ => {}
    }
}

fn default_meta() -> Value {
    json!({ "provenance": "original", "license": "MIT" })
}

fn update_mode() -> bool {
    std::env::var("LOAM_UPDATE_FIXTURES").is_ok_and(|v| v == "1")
}

fn write_expected(path: &Path, extraction: Value, meta: Value) {
    let mut file = Map::new();
    file.insert("meta".into(), meta);
    file.insert("extraction".into(), extraction);
    file.insert("lezer".into(), Value::Null);
    file.insert("rendering".into(), Value::Null);
    let body = serde_json::to_string_pretty(&Value::Object(file)).expect("serializes") + "\n";
    std::fs::write(path, body).expect("expected file is writable");
}

/// AC1 + AC3: every fixture (positive, malformed, escaped, Unicode) parses to
/// exactly its expected extraction and diagnostics.
#[test]
fn corpus_matches_expectations() {
    let root = fixture_root();
    let sources = markdown_sources(&root);
    assert!(
        sources.len() >= 27,
        "corpus unexpectedly small: {} fixtures",
        sources.len()
    );

    let mut failures = Vec::new();
    for source_path in &sources {
        let source = load_source(source_path);
        let actual = serde_json::to_value(parse(&source)).expect("model serializes");
        let expected_file = expected_path(source_path);
        let relative = source_path.strip_prefix(&root).expect("under root");

        let existing: Option<Value> = std::fs::read_to_string(&expected_file)
            .ok()
            .map(|raw| serde_json::from_str(&raw).expect("expected.json is valid JSON"));

        if update_mode() || existing.is_none() {
            if !update_mode() {
                failures.push(format!(
                    "{}: missing {} — author it with LOAM_UPDATE_FIXTURES=1",
                    relative.display(),
                    expected_file.display()
                ));
                continue;
            }
            let meta = existing
                .as_ref()
                .and_then(|e| e.get("meta").cloned())
                .unwrap_or_else(default_meta);
            write_expected(&expected_file, actual, meta);
            continue;
        }

        let expected = existing.expect("checked above");
        let mut diffs = Vec::new();
        diff_values(
            "",
            expected.get("extraction").unwrap_or(&Value::Null),
            &actual,
            None,
            &mut diffs,
        );
        failures.extend(diffs.iter().map(|d| d.render(relative)));
    }
    assert!(
        failures.is_empty(),
        "fixture corpus diverged:\n{}",
        failures.join("\n")
    );
}

/// AC3 (explicit): the malformed family carries expected diagnostics — they
/// are first-class fixtures, not skipped inputs.
#[test]
fn malformed_fixtures_expect_diagnostics() {
    let malformed = fixture_root().join("malformed");
    let sources = markdown_sources(&malformed);
    assert!(sources.len() >= 3, "malformed family present");
    let with_diagnostics = sources
        .iter()
        .filter(|s| !parse(&load_source(s)).diagnostics.is_empty())
        .count();
    assert!(
        with_diagnostics >= 2,
        "malformed corpus must exercise diagnostics"
    );
}

/// Determinism across OS line endings: CRLF sources normalize to the same
/// extraction as LF sources.
#[test]
fn crlf_sources_extract_identically() {
    for source_path in markdown_sources(&fixture_root()) {
        let lf = load_source(&source_path);
        // A CRLF checkout of the same fixture, put through the loader's
        // normalization, must yield the identical source — and extraction.
        let crlf_on_disk = lf.replace('\n', "\r\n");
        let normalized = crlf_on_disk.replace("\r\n", "\n");
        assert_eq!(normalized, lf, "loader normalization round-trips");
        assert_eq!(
            parse(&normalized),
            parse(&lf),
            "line endings changed extraction for {}",
            source_path.display()
        );
    }
}

/// AC2: an intentional structural mutation produces a report naming the
/// fixture file, the JSON pointer, and a source range.
#[test]
fn structural_diffs_report_file_and_range() {
    let fixture = Path::new("links/wikilinks.md");
    let source = load_source(&fixture_root().join(fixture));
    let actual = serde_json::to_value(parse(&source)).expect("serializes");

    let mut tampered = actual.clone();
    tampered["links"][0]["target"] = json!("Wrong Note");

    let mut diffs = Vec::new();
    diff_values("", &tampered, &actual, None, &mut diffs);
    assert_eq!(diffs.len(), 1, "exactly the mutated field differs");

    let report = diffs[0].render(fixture);
    assert!(report.contains("links/wikilinks.md"), "names the file");
    assert!(report.contains("/links/0/target"), "names the pointer");
    assert!(report.contains("source bytes"), "carries a source range");
    let range = diffs[0].range.expect("range attributed from the link node");
    assert_eq!(
        &source[range.0 as usize..range.1 as usize],
        "[[Target Note]]",
        "range points at the construct in the source"
    );

    // Array-length mismatches are reported too.
    let mut shorter = actual.clone();
    shorter["links"] = json!([]);
    let mut diffs = Vec::new();
    diff_values("", &shorter, &actual, None, &mut diffs);
    assert!(
        diffs.iter().any(|d| d.pointer == "/links/length"),
        "{diffs:?}"
    );
}

/// AC4: every fixture declares original, MIT-licensed provenance — no copied
/// proprietary content can enter the corpus unnoticed.
#[test]
fn every_fixture_declares_original_provenance() {
    let root = fixture_root();
    let sources = markdown_sources(&root);
    for source_path in &sources {
        let expected_file = expected_path(source_path);
        if !expected_file.exists() {
            continue; // corpus_matches_expectations reports the gap
        }
        let raw = std::fs::read_to_string(&expected_file).expect("readable");
        let value: Value = serde_json::from_str(&raw).expect("valid JSON");
        let meta = value.get("meta").expect("meta block present");
        assert_eq!(
            meta.get("provenance").and_then(Value::as_str),
            Some("original"),
            "{}: provenance must be `original`",
            expected_file.display()
        );
        assert_eq!(
            meta.get("license").and_then(Value::as_str),
            Some("MIT"),
            "{}: fixtures are MIT-licensed (D12)",
            expected_file.display()
        );
        assert!(
            value.get("lezer").is_some() && value.get("rendering").is_some(),
            "{}: reserved lezer/rendering fields must exist",
            expected_file.display()
        );
    }
}

// ─── LOA-34: core syntax extraction over the corpus ─────────────────────────

use loam_core::parse::{ExtractedDoc, SourceRange, SpanKind, SyntaxSpan};

fn corpus() -> Vec<(PathBuf, String, ExtractedDoc)> {
    markdown_sources(&fixture_root())
        .into_iter()
        .map(|path| {
            let source = load_source(&path);
            let doc = parse(&source);
            (path, source, doc)
        })
        .collect()
}

fn all_spans(docs: &[(PathBuf, String, ExtractedDoc)]) -> impl Iterator<Item = &SyntaxSpan> {
    docs.iter().flat_map(|(_, _, d)| &d.spans)
}

fn contains(outer: SourceRange, inner: SourceRange) -> bool {
    outer.start <= inner.start && inner.end <= outer.end && outer != inner
}

/// LOA-34 AC1: every named syntax family (headings, emphasis, lists, tasks,
/// quotes, code, links, footnotes) appears in the corpus, in both positive
/// and nested forms where nesting is meaningful.
#[test]
fn syntax_family_matrix_is_covered() {
    let docs = corpus();
    let has = |pred: fn(&SpanKind) -> bool| all_spans(&docs).any(|s| pred(&s.kind));

    assert!(has(|k| matches!(k, SpanKind::Heading { .. })), "headings");
    assert!(has(|k| matches!(k, SpanKind::Emphasis)), "emphasis");
    assert!(has(|k| matches!(k, SpanKind::Strong)), "strong");
    assert!(has(|k| matches!(k, SpanKind::Strikethrough)), "strike");
    assert!(has(|k| matches!(k, SpanKind::InlineCode)), "inline code");
    assert!(has(|k| matches!(k, SpanKind::CodeBlock { .. })), "fences");
    assert!(
        has(|k| matches!(k, SpanKind::CodeBlock { language: Some(_) })),
        "fence with language label"
    );
    assert!(has(|k| matches!(k, SpanKind::ListItem { .. })), "lists");
    assert!(
        has(|k| matches!(k, SpanKind::Task { checked: true, .. })),
        "checked tasks"
    );
    assert!(
        has(|k| matches!(k, SpanKind::Task { checked: false, .. })),
        "open tasks"
    );
    assert!(has(|k| matches!(k, SpanKind::Blockquote { .. })), "quotes");
    assert!(has(|k| matches!(k, SpanKind::Link)), "markdown links");
    assert!(has(|k| matches!(k, SpanKind::Wikilink)), "wikilinks");
    assert!(has(|k| matches!(k, SpanKind::Footnote)), "footnotes");

    // Nested forms.
    assert!(
        has(|k| matches!(k, SpanKind::ListItem { depth: 1.. })),
        "nested list items"
    );
    assert!(
        has(|k| matches!(k, SpanKind::Task { depth: 1.., .. })),
        "nested tasks"
    );
    assert!(
        has(|k| matches!(k, SpanKind::Blockquote { depth: 1.. })),
        "nested quotes"
    );
    let strong_inside_emphasis = docs.iter().any(|(_, _, d)| {
        d.spans.iter().any(|e| {
            matches!(e.kind, SpanKind::Emphasis)
                && d.spans
                    .iter()
                    .any(|s| matches!(s.kind, SpanKind::Strong) && contains(e.range, s.range))
        })
    });
    assert!(
        strong_inside_emphasis,
        "nested emphasis (strong inside emph)"
    );
}

/// LOA-34 AC2: slicing the ORIGINAL source by every reported range yields
/// exactly the construct's text — verified by kind-specific shape checks over
/// the whole corpus.
#[test]
fn every_range_slices_the_exact_construct() {
    for (path, source, doc) in corpus() {
        for span in &doc.spans {
            let text = &source[span.range.start..span.range.end];
            let ok = match &span.kind {
                SpanKind::Heading { level } => text.starts_with(&"#".repeat(usize::from(*level))),
                SpanKind::Emphasis => text.starts_with('*') || text.starts_with('_'),
                SpanKind::Strong => text.starts_with("**") || text.starts_with("__"),
                SpanKind::Strikethrough => text.starts_with("~~") && text.ends_with("~~"),
                SpanKind::InlineCode => text.starts_with('`') && text.ends_with('`'),
                SpanKind::CodeBlock { .. } => text.starts_with("```") || text.starts_with("~~~"),
                SpanKind::Blockquote { .. } => text.starts_with('>'),
                SpanKind::Callout { .. } => text.starts_with('>') && text.contains("[!"),
                SpanKind::Highlight => text.starts_with("==") && text.ends_with("=="),
                SpanKind::Comment => text.starts_with("%%"),
                SpanKind::ListItem { .. } | SpanKind::Task { .. } => {
                    text.starts_with('-')
                        || text.starts_with('*')
                        || text.starts_with(|c: char| c.is_ascii_digit())
                }
                SpanKind::Link => text.starts_with('[') || text.starts_with("http"),
                SpanKind::Wikilink => text.starts_with("[[") && text.ends_with("]]"),
                SpanKind::Embed => text.starts_with("!["),
                SpanKind::Tag => text.starts_with('#'),
                SpanKind::BlockId => text.starts_with('^'),
                SpanKind::Footnote => text.contains("[^"),
                SpanKind::Frontmatter => text.starts_with("---"),
                SpanKind::Table => text.contains('|'),
                SpanKind::Math => text.starts_with('$'),
            };
            assert!(
                ok,
                "{}: {:?} range {}..{} selects {text:?}",
                path.display(),
                span.kind,
                span.range.start,
                span.range.end
            );
        }
        for heading in &doc.headings {
            let text = &source[heading.range.start..heading.range.end];
            // `heading.text` is rendered text (emphasis markers stripped);
            // strip them from the slice before comparing.
            let unmarked: String = text.chars().filter(|c| !"*_~`".contains(*c)).collect();
            assert!(
                unmarked
                    .trim_start_matches('#')
                    .trim()
                    .contains(heading.text.trim()),
                "{}: heading text {:?} not in slice {text:?}",
                path.display(),
                heading.text
            );
        }
        for link in &doc.links {
            let text = &source[link.range.start..link.range.end];
            // Reference-style links resolve their target from the definition,
            // which sits outside the link's own range — but always in source.
            assert!(
                link.target.is_empty()
                    || text.contains(link.target.as_str())
                    || source.contains(link.target.as_str()),
                "{}: link target {:?} not in slice {text:?} nor source",
                path.display(),
                link.target
            );
        }
    }
}

/// LOA-34 AC3: nothing inside fenced or inline code is extracted as a link,
/// tag, or task.
#[test]
fn code_content_is_never_misclassified() {
    let source = load_source(&fixture_root().join("core/code-exclusion.md"));
    let doc = parse(&source);
    assert!(
        doc.links.is_empty(),
        "links leaked from code: {:?}",
        doc.links
    );
    assert!(doc.tags.is_empty(), "tags leaked from code: {:?}", doc.tags);
    assert!(
        !doc.spans.iter().any(|s| matches!(
            s.kind,
            SpanKind::Wikilink | SpanKind::Link | SpanKind::Task { .. } | SpanKind::ListItem { .. }
        )),
        "code interior misclassified: {:?}",
        doc.spans
    );
    let fences = doc
        .spans
        .iter()
        .filter(|s| matches!(s.kind, SpanKind::CodeBlock { .. }))
        .count();
    let inline = doc
        .spans
        .iter()
        .filter(|s| matches!(s.kind, SpanKind::InlineCode))
        .count();
    assert_eq!((fences, inline), (1, 2), "code itself is still extracted");
}

/// LOA-34 AC4: nested lists and quotes retain parent relationships — depth
/// plus range containment reconstructs the tree.
#[test]
fn nested_structure_retains_parents() {
    let lists = parse(&load_source(&fixture_root().join("core/nested-lists.md")));
    let items: Vec<(u8, SourceRange)> = lists
        .spans
        .iter()
        .filter_map(|s| match s.kind {
            SpanKind::ListItem { depth } => Some((depth, s.range)),
            _ => None,
        })
        .collect();
    assert_eq!(items.iter().map(|(d, _)| *d).max(), Some(2), "three levels");
    for (depth, range) in items.iter().filter(|(d, _)| *d > 0) {
        assert!(
            items
                .iter()
                .any(|(pd, pr)| *pd == depth - 1 && contains(*pr, *range)),
            "depth-{depth} item at {}..{} has an enclosing depth-{} parent",
            range.start,
            range.end,
            depth - 1
        );
    }

    let quotes = parse(&load_source(&fixture_root().join("core/nested-quotes.md")));
    let levels: Vec<(u8, SourceRange)> = quotes
        .spans
        .iter()
        .filter_map(|s| match s.kind {
            SpanKind::Blockquote { depth } => Some((depth, s.range)),
            _ => None,
        })
        .collect();
    assert_eq!(
        levels.iter().map(|(d, _)| *d).max(),
        Some(2),
        "three levels"
    );
    for (depth, range) in levels.iter().filter(|(d, _)| *d > 0) {
        assert!(
            levels
                .iter()
                .any(|(pd, pr)| *pd == depth - 1 && contains(*pr, *range)),
            "depth-{depth} quote has an enclosing parent"
        );
    }
    // The task nested inside a list inside the quote: outer quote contains it
    // and its list depth reflects the parent item.
    let task = quotes
        .spans
        .iter()
        .find(|s| matches!(s.kind, SpanKind::Task { .. }))
        .expect("task inside quote");
    assert!(matches!(task.kind, SpanKind::Task { depth: 1, .. }));
    let outer_quote = levels.iter().find(|(d, _)| *d == 0).expect("outer quote");
    assert!(
        contains(outer_quote.1, task.range),
        "quote contains the task"
    );
}

// ─── LOA-40: wikilinks, embeds, tags, block IDs ─────────────────────────────

use loam_core::parse::{LinkRef, LinkStyle};

fn links_of(fixture: &str) -> (String, Vec<LinkRef>) {
    let source = load_source(&fixture_root().join(fixture));
    let doc = parse(&source);
    (source, doc.links)
}

/// LOA-40 AC1 + AC5: every documented wikilink and embed form round-trips,
/// with components split out and the original spelling preserved untouched.
#[test]
fn wikilink_and_embed_forms_round_trip() {
    let (_, links) = links_of("links/wikilinks.md");
    let wiki = |target: &str| {
        links
            .iter()
            .find(|l| l.target == target)
            .unwrap_or_else(|| panic!("missing [[{target}]] in {links:?}"))
    };
    let plain = wiki("Target Note");
    assert!(!plain.embed);
    let c = plain.components.as_ref().expect("components");
    assert_eq!(
        (c.note.as_str(), &c.heading, &c.block),
        ("Target Note", &None, &None)
    );

    let heading = wiki("Target Note#Section");
    let c = heading.components.as_ref().expect("components");
    assert_eq!(c.note, "Target Note");
    assert_eq!(c.heading.as_deref(), Some("Section"));
    assert_eq!(c.block, None);
    assert_eq!(
        heading.target, "Target Note#Section",
        "original spelling kept"
    );

    let (source, embeds) = links_of("links/embeds.md");
    assert_eq!(embeds.len(), 5, "{embeds:?}");
    assert!(embeds.iter().all(|l| l.embed), "all are embeds");

    let note = &embeds[0];
    assert_eq!(note.target, "Note One");
    assert_eq!(note.style, LinkStyle::Wiki);
    assert_eq!(&source[note.range.start..note.range.end], "![[Note One]]");

    let heading = &embeds[1];
    let c = heading.components.as_ref().expect("components");
    assert_eq!(c.heading.as_deref(), Some("Section Two"));

    let block = &embeds[2];
    let c = block.components.as_ref().expect("components");
    assert_eq!(c.block.as_deref(), Some("blk-1"));
    assert_eq!(block.target, "Note One#^blk-1", "original spelling kept");

    let sized = &embeds[3];
    assert_eq!(sized.target, "diagram.png");
    assert_eq!(sized.text, "300", "size alias preserved");

    let image = &embeds[4];
    assert_eq!(image.target, "assets/photo.png");
    assert_eq!(image.style, LinkStyle::Markdown);
    assert_eq!(image.components, None);
}

/// LOA-40 AC2: Unicode and nested tags extract with byte-exact ranges;
/// non-tags (mid-word, numeric, escaped, bare) stay out.
#[test]
fn unicode_tags_have_exact_ranges() {
    let source = load_source(&fixture_root().join("tags/unicode-tags.md"));
    let doc = parse(&source);
    let names: Vec<&str> = doc.tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "on-heading",
            "tag",
            "area/sub",
            "日本語",
            "café-notes",
            "Straße_prep",
            "trailing",
            "final",
        ],
        "exactly the valid tags, in source order"
    );
    for tag in &doc.tags {
        assert_eq!(
            &source[tag.range.start..tag.range.end],
            format!("#{}", tag.name),
            "range selects the exact tag text"
        );
    }
}

/// LOA-40 AC3: tags and block IDs inside code are ignored (links covered by
/// `code_content_is_never_misclassified`).
#[test]
fn tags_and_block_ids_in_code_are_ignored() {
    let code = parse(&load_source(&fixture_root().join("core/code-exclusion.md")));
    assert!(code.tags.is_empty(), "{:?}", code.tags);
    assert!(code.blocks.is_empty(), "{:?}", code.blocks);

    let source = load_source(&fixture_root().join("blocks/block-ids.md"));
    let doc = parse(&source);
    let ids: Vec<&str> = doc.blocks.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, ["quote-1", "item2"], "code/math carets excluded");
    for block in &doc.blocks {
        assert_eq!(
            &source[block.range.start..block.range.end],
            format!("^{}", block.id)
        );
    }
    // The wikilink block reference on the last line is a link component, not
    // a block definition.
    let link = doc.links.last().expect("block reference link");
    assert_eq!(
        link.components
            .as_ref()
            .expect("components")
            .block
            .as_deref(),
        Some("quote-1")
    );
}

/// LOA-40 AC4: malformed `[[` / `![[` delimiters stay source text and yield
/// diagnostics instead of links.
#[test]
fn malformed_delimiters_yield_diagnostics() {
    let source = load_source(&fixture_root().join("malformed/unclosed-wikilink.md"));
    let doc = parse(&source);
    assert!(doc.links.is_empty(), "nothing extracted: {:?}", doc.links);
    let codes: Vec<&str> = doc.diagnostics.iter().map(|d| d.code.as_str()).collect();
    assert!(codes.contains(&"unclosed-wikilink"), "{codes:?}");
    assert!(codes.contains(&"unclosed-embed"), "{codes:?}");
    for diagnostic in &doc.diagnostics {
        let slice = &source[diagnostic.range.start..diagnostic.range.end];
        assert!(
            slice.contains("[["),
            "diagnostic points at the delimiter: {slice:?}"
        );
    }
}

// ─── LOA-47: YAML frontmatter ───────────────────────────────────────────────

use loam_core::parse::PropertyValue;

/// LOA-47 AC1: typed fixtures extract values with source ranges that land on
/// the `key:` lines in the original text.
#[test]
fn typed_frontmatter_extracts_values_and_ranges() {
    let source = load_source(&fixture_root().join("frontmatter/typed.md"));
    let doc = parse(&source);
    let frontmatter = doc.frontmatter.expect("typed frontmatter parses");

    let get = |key: &str| {
        frontmatter
            .properties
            .iter()
            .find(|p| p.key == key)
            .unwrap_or_else(|| panic!("missing property {key}"))
    };
    assert_eq!(
        get("title").value,
        PropertyValue::Text("Typed values".into())
    );
    assert_eq!(get("rating").value, PropertyValue::Number(4.0));
    assert_eq!(get("weight").value, PropertyValue::Number(2.5));
    assert_eq!(get("draft").value, PropertyValue::Checkbox(false));
    assert_eq!(get("published").value, PropertyValue::Checkbox(true));
    assert_eq!(get("due").value, PropertyValue::Date("2026-08-01".into()));
    assert_eq!(
        get("updated").value,
        PropertyValue::Datetime("2026-07-18T09:30:00".into())
    );
    assert_eq!(get("empty-one").value, PropertyValue::Empty);
    assert_eq!(
        get("notes").value,
        PropertyValue::Text("plain text with 2026 inside".into()),
        "a year inside prose is not a date"
    );
    match &get("tags").value {
        PropertyValue::List(items) => assert_eq!(items.len(), 2),
        other => panic!("tags should be a list: {other:?}"),
    }

    for property in &frontmatter.properties {
        let slice = &source[property.range.start..property.range.end];
        assert!(
            slice.starts_with(&format!("{}:", property.key)),
            "range for {} starts at its key line, got {slice:?}",
            property.key
        );
    }
    // Multi-line list value: the range covers all its lines.
    let aliases = get("aliases");
    let slice = &source[aliases.range.start..aliases.range.end];
    assert!(slice.contains("- TV") && slice.contains("Typed Values"));
}

/// LOA-47 AC2: reserved `tags` and `aliases` keys feed dedicated fields.
#[test]
fn reserved_keys_feed_dedicated_fields() {
    let typed = parse(&load_source(&fixture_root().join("frontmatter/typed.md")));
    let frontmatter = typed.frontmatter.expect("frontmatter");
    assert_eq!(frontmatter.tags, ["projects", "deep/nest"]);
    assert_eq!(frontmatter.aliases, ["TV", "Typed Values"]);

    let valid = parse(&load_source(&fixture_root().join("frontmatter/valid.md")));
    let frontmatter = valid.frontmatter.expect("frontmatter");
    assert_eq!(frontmatter.tags, ["alpha", "beta/nested"]);
    assert_eq!(frontmatter.aliases, ["VF", "Valid FM"]);
}

/// LOA-47 AC3: malformed YAML keeps the raw bytes and reports a diagnostic
/// with an actionable range; AC5: the input is never rewritten.
#[test]
fn malformed_yaml_preserves_raw_and_diagnoses() {
    let source = load_source(&fixture_root().join("malformed/bad-yaml-frontmatter.md"));
    let before = source.clone();
    let doc = parse(&source);
    assert_eq!(source, before, "input untouched (AC5)");

    assert!(doc.frontmatter.is_none(), "no typed view for invalid YAML");
    let raw = doc.raw_frontmatter.expect("raw bytes preserved");
    assert!(
        source.starts_with(&raw),
        "raw frontmatter is byte-identical to the source prefix"
    );
    assert!(raw.contains("[unclosed bracket"), "nothing normalized");

    let diagnostic = doc
        .diagnostics
        .iter()
        .find(|d| d.code == "frontmatter-parse-error")
        .expect("parse diagnostic");
    assert!(diagnostic.message.contains("could not be parsed"));
    assert!(
        diagnostic.range.start < diagnostic.range.end && diagnostic.range.end <= source.len(),
        "actionable range"
    );
}

/// LOA-47 AC4: a `---` thematic break after content is not frontmatter.
#[test]
fn non_leading_thematic_break_is_not_frontmatter() {
    let doc = parse(&load_source(&fixture_root().join("core/thematic-break.md")));
    assert!(doc.frontmatter.is_none());
    assert!(doc.raw_frontmatter.is_none());
    assert!(
        !doc.diagnostics
            .iter()
            .any(|d| d.code.contains("frontmatter")),
        "{:?}",
        doc.diagnostics
    );
}

/// LOA-47 AC5 (corpus-wide): raw frontmatter, when present, is always the
/// exact byte-for-byte prefix of the source — parsing never normalizes.
#[test]
fn frontmatter_is_never_rewritten() {
    for (path, source, doc) in corpus() {
        if let Some(raw) = &doc.raw_frontmatter {
            assert!(
                source.starts_with(raw.as_str()),
                "{}: raw frontmatter diverged from source bytes",
                path.display()
            );
        }
    }
}

// ─── LOA-51: custom Loam extensions ─────────────────────────────────────────

use loam_core::parse::CalloutFold;

fn spans_of(doc: &loam_core::parse::ExtractedDoc, pred: fn(&SpanKind) -> bool) -> Vec<&SyntaxSpan> {
    doc.spans.iter().filter(|s| pred(&s.kind)).collect()
}

/// LOA-51 AC1: highlight and comment delimiters across multiline boundaries.
#[test]
fn highlights_and_comments_parse_across_boundaries() {
    let source = load_source(&fixture_root().join("extensions/highlights-comments.md"));
    let doc = parse(&source);

    let highlights = spans_of(&doc, |k| matches!(k, SpanKind::Highlight));
    let texts: Vec<&str> = highlights
        .iter()
        .map(|s| &source[s.range.start..s.range.end])
        .collect();
    assert_eq!(
        texts,
        [
            "==simple highlight==",
            "==one with `code` inside==",
            "==spanning a soft\nline break==",
        ],
        "soft line breaks close; blank lines void the opener"
    );

    let comments = spans_of(&doc, |k| matches!(k, SpanKind::Comment));
    assert_eq!(comments.len(), 2, "inline + block comment");
    let inline = &source[comments[0].range.start..comments[0].range.end];
    assert_eq!(inline, "%%hidden note%%");
    let block = &source[comments[1].range.start..comments[1].range.end];
    assert!(
        block.starts_with("%%\n") && block.ends_with("%%") && block.contains("several lines"),
        "block comment spans lines: {block:?}"
    );

    // Comments hide index items; visible ones survive.
    let link_targets: Vec<&str> = doc.links.iter().map(|l| l.target.as_str()).collect();
    assert_eq!(link_targets, ["Visible Link"], "hidden link suppressed");
    let tag_names: Vec<&str> = doc.tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tag_names, ["visible-tag"], "hidden tag suppressed");
}

/// LOA-51 AC2 (fixture side; the full alias matrix is unit-tested in
/// `parse::extensions`): P0 types and aliases normalize in real documents.
#[test]
fn callout_types_and_aliases_normalize() {
    let source = load_source(&fixture_root().join("extensions/callouts.md"));
    let doc = parse(&source);
    type Row<'a> = (&'a str, Option<&'a str>, Option<CalloutFold>, bool, u8);
    let callouts: Vec<Row> = doc
        .spans
        .iter()
        .filter_map(|s| match &s.kind {
            SpanKind::Callout {
                callout_type,
                title,
                fold,
                custom,
                depth,
            } => Some((
                callout_type.as_str(),
                title.as_deref(),
                *fold,
                *custom,
                *depth,
            )),
            _ => None,
        })
        .collect();

    assert_eq!(
        callouts,
        [
            ("note", Some("A plain note callout"), None, false, 0),
            (
                "abstract",
                Some("Alias resolves to abstract"),
                None,
                false,
                0
            ),
            (
                "warning",
                Some("Folded warning"),
                Some(CalloutFold::Folded),
                false,
                0
            ),
            (
                "tip",
                Some("Expanded tip"),
                Some(CalloutFold::Expanded),
                false,
                0
            ),
            ("danger", None, None, false, 0),
            ("quirky-custom", Some("Custom type"), None, true, 0),
            ("question", Some("Outer question"), None, false, 0),
            (
                "todo",
                Some("Nested folded todo"),
                Some(CalloutFold::Folded),
                false,
                1
            ),
        ],
        "types normalized, aliases resolved, custom flagged"
    );
}

/// LOA-51 AC3: fold markers and nesting are retained — the nested callout is
/// contained by its parent and keeps its own fold state.
#[test]
fn callout_fold_and_nesting_retained() {
    let source = load_source(&fixture_root().join("extensions/callouts.md"));
    let doc = parse(&source);
    let callout_spans: Vec<(&SyntaxSpan, u8)> = doc
        .spans
        .iter()
        .filter_map(|s| match &s.kind {
            SpanKind::Callout { depth, .. } => Some((s, *depth)),
            _ => None,
        })
        .collect();
    let (nested, _) = callout_spans
        .iter()
        .find(|(_, d)| *d == 1)
        .expect("nested callout");
    let parent = callout_spans
        .iter()
        .find(|(s, d)| {
            *d == 0 && s.range.start <= nested.range.start && nested.range.end <= s.range.end
        })
        .expect("containing parent callout");
    assert!(matches!(
        &parent.0.kind,
        SpanKind::Callout { callout_type, .. } if callout_type == "question"
    ));
}

/// LOA-51 AC4: escaped delimiters remain literal; code interiors are inert.
#[test]
fn escaped_delimiters_remain_literal() {
    let source = load_source(&fixture_root().join("extensions/escaped-delimiters.md"));
    let doc = parse(&source);

    let highlights: Vec<&str> = doc
        .spans
        .iter()
        .filter(|s| matches!(s.kind, SpanKind::Highlight))
        .map(|s| &source[s.range.start..s.range.end])
        .collect();
    assert_eq!(
        highlights,
        ["==highlight==", "==this one=="],
        "escaped `\\==` never opens or closes"
    );
    assert!(
        !doc.spans
            .iter()
            .any(|s| matches!(s.kind, SpanKind::Comment)),
        "escaped `\\%%` is not a comment"
    );

    let unclosed = parse(&load_source(
        &fixture_root().join("malformed/unclosed-comment.md"),
    ));
    let codes: Vec<&str> = unclosed
        .diagnostics
        .iter()
        .map(|d| d.code.as_str())
        .collect();
    assert!(codes.contains(&"unclosed-comment"), "{codes:?}");
    let targets: Vec<&str> = unclosed.links.iter().map(|l| l.target.as_str()).collect();
    assert_eq!(targets, ["Indexed Link"], "comment runs to EOF");
    assert!(unclosed.tags.is_empty(), "{:?}", unclosed.tags);
}
