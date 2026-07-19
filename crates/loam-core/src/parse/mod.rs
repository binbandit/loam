//! Markdown parsing (D4, §3.3): comrak is the single core grammar — the same
//! configuration serves indexing now and the Reading-view WASM binding later,
//! so index and render can never drift. Parser configuration lives HERE and
//! nowhere else.

mod extensions;
mod frontmatter;
mod model;

pub use model::{
    BlockRef, CalloutFold, Diagnostic, ExtractedDoc, Frontmatter, HeadingRef, LinkRef, LinkStyle,
    Property, PropertyValue, Severity, SourceRange, SpanKind, SyntaxSpan, TagRef, WikiComponents,
};

use comrak::nodes::{AstNode, NodeValue, Sourcepos};
use comrak::{Arena, Options};

/// The one true comrak configuration (D4): CommonMark + GFM + the §3.3 set
/// comrak supports natively. Custom Loam syntax (`==highlight==`,
/// `%%comments%%`, callout normalization, embeds, block IDs) is layered in
/// LOA-51 on top of THIS configuration, never beside it.
pub fn options() -> Options<'static> {
    let mut options = Options::default();
    // GFM set.
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    // §3.3 extensions comrak carries natively.
    options.extension.front_matter_delimiter = Some("---".into());
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.math_dollars = true;
    // Callouts are deliberately NOT comrak's `alerts` extension: it covers
    // only GitHub's five types and no fold markers. All `> [!type]` quotes
    // stay plain blockquotes and are normalized in `extensions.rs`.
    // Source fidelity: no smart punctuation, no source rewriting.
    options.parse.smart = false;
    options
}

/// Parse `source` into the shared extracted model. Never panics on any input;
/// malformed constructs surface as [`Diagnostic`]s, and the source is never
/// altered (the model carries byte ranges into the original text).
pub fn parse(source: &str) -> ExtractedDoc {
    let arena = Arena::new();
    let options = options();
    let root = comrak::parse_document(&arena, source, &options);

    let lines = LineIndex::new(source);
    let mut doc = ExtractedDoc::default();
    extract(root, &lines, &mut doc);
    extensions::extract_inline_extensions(source, &mut doc);
    extract_block_ids(source, &mut doc);
    doc.links.sort_by_key(|l| (l.range.start, l.range.end));
    doc.tags.sort_by_key(|t| (t.range.start, t.range.end));
    doc.spans.sort_by_key(|s| (s.range.start, s.range.end));
    diagnose(source, &mut doc);
    doc
}

/// Split a wikilink target into components, preserving the original spelling
/// in the caller's `target`: `Note`, `Note#Heading`, `Note#^block`.
fn wiki_components(raw: &str) -> WikiComponents {
    match raw.split_once('#') {
        Some((note, fragment)) => match fragment.strip_prefix('^') {
            Some(block) => WikiComponents {
                note: note.to_string(),
                heading: None,
                block: Some(block.to_string()),
            },
            None => WikiComponents {
                note: note.to_string(),
                heading: Some(fragment.to_string()),
                block: None,
            },
        },
        None => WikiComponents {
            note: raw.to_string(),
            heading: None,
            block: None,
        },
    }
}

/// Precomputed byte offset of each line start, for O(1) sourcepos → byte
/// range conversion (the parse sits inside the <30 ms reindex budget).
struct LineIndex<'s> {
    source: &'s str,
    starts: Vec<usize>,
}

impl<'s> LineIndex<'s> {
    fn new(source: &'s str) -> Self {
        Self {
            source,
            starts: std::iter::once(0)
                .chain(source.match_indices('\n').map(|(i, _)| i + 1))
                .collect(),
        }
    }

    /// comrak sourcepos is 1-based (line, column) with an inclusive end
    /// column; convert to an end-exclusive byte range, clamped to the source.
    /// Inline sourcepos around multi-byte characters is imprecise upstream,
    /// so offsets are snapped down to the nearest char boundary — a range is
    /// always safely sliceable even when comrak's column is off.
    fn range(&self, pos: &Sourcepos) -> SourceRange {
        let line = |n: usize| self.starts[n.clamp(1, self.starts.len()) - 1];
        let snap = |mut i: usize| {
            i = i.min(self.source.len());
            while i > 0 && !self.source.is_char_boundary(i) {
                i -= 1;
            }
            i
        };
        let start = snap(line(pos.start.line) + pos.start.column.saturating_sub(1));
        let end = snap(line(pos.end.line) + pos.end.column);
        SourceRange {
            start,
            end: end.max(start),
        }
    }
}

fn text_of<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    for child in node.descendants() {
        if let NodeValue::Text(text) = &child.data.borrow().value {
            out.push_str(text);
        }
    }
    out
}

fn is_list_item(value: &NodeValue) -> bool {
    matches!(value, NodeValue::Item(_) | NodeValue::TaskItem(_))
}

/// 0-based nesting depth: how many ancestors of `node` match `family`.
/// Combined with range containment this preserves the parent tree (AC4)
/// without a second traversal — `ancestors()` walks parent links only.
fn nesting_depth<'a>(node: &'a AstNode<'a>, family: fn(&NodeValue) -> bool) -> u8 {
    node.ancestors()
        .skip(1)
        .filter(|a| family(&a.data.borrow().value))
        .count()
        .min(u8::MAX as usize) as u8
}

fn extract<'a>(root: &'a AstNode<'a>, lines: &LineIndex, doc: &mut ExtractedDoc) {
    // `descendants()` traverses iteratively — arbitrarily deep nesting (10k
    // blockquotes) must never overflow the stack (AC3).
    for child in root.descendants().skip(1) {
        let data = child.data.borrow();
        let range = lines.range(&data.sourcepos);
        let span = |kind: SpanKind| SyntaxSpan { kind, range };
        match &data.value {
            NodeValue::Heading(heading) => {
                doc.headings.push(HeadingRef {
                    level: heading.level,
                    text: text_of(child),
                    range,
                });
                doc.spans.push(span(SpanKind::Heading {
                    level: heading.level,
                }));
            }
            NodeValue::Link(link) => {
                doc.links.push(LinkRef {
                    target: link.url.clone(),
                    text: text_of(child),
                    style: LinkStyle::Markdown,
                    embed: false,
                    components: None,
                    range,
                });
                doc.spans.push(span(SpanKind::Link));
            }
            NodeValue::Image(image) => {
                doc.links.push(LinkRef {
                    target: image.url.clone(),
                    text: text_of(child),
                    style: LinkStyle::Markdown,
                    embed: true,
                    components: None,
                    range,
                });
                doc.spans.push(span(SpanKind::Embed));
            }
            NodeValue::WikiLink(link) => {
                doc.links.push(LinkRef {
                    target: link.url.clone(),
                    text: text_of(child),
                    style: LinkStyle::Wiki,
                    embed: false,
                    components: Some(wiki_components(&link.url)),
                    range,
                });
                doc.spans.push(span(SpanKind::Wikilink));
            }
            NodeValue::Text(text) => {
                scan_inline_text(text, &data.sourcepos, lines, doc);
            }
            NodeValue::CodeBlock(code) => {
                let language = code
                    .info
                    .split_whitespace()
                    .next()
                    .filter(|lang| !lang.is_empty())
                    .map(str::to_string);
                doc.spans.push(span(SpanKind::CodeBlock { language }));
            }
            NodeValue::FrontMatter(raw) => {
                doc.raw_frontmatter = Some(raw.clone());
                doc.spans.push(span(SpanKind::Frontmatter));
                frontmatter::extract_frontmatter(raw, range, doc);
            }
            NodeValue::Emph => doc.spans.push(span(SpanKind::Emphasis)),
            NodeValue::Strong => doc.spans.push(span(SpanKind::Strong)),
            NodeValue::Strikethrough => doc.spans.push(span(SpanKind::Strikethrough)),
            NodeValue::BlockQuote => {
                let depth = nesting_depth(child, |v| matches!(v, NodeValue::BlockQuote));
                let slice = &lines.source[range.start..range.end];
                match extensions::callout_header(slice) {
                    Some(header) => doc.spans.push(span(SpanKind::Callout {
                        callout_type: header.callout_type,
                        title: header.title,
                        fold: header.fold,
                        custom: header.custom,
                        depth,
                    })),
                    None => doc.spans.push(span(SpanKind::Blockquote { depth })),
                }
            }
            NodeValue::Item(_) => doc.spans.push(span(SpanKind::ListItem {
                depth: nesting_depth(child, is_list_item),
            })),
            NodeValue::TaskItem(state) => doc.spans.push(span(SpanKind::Task {
                checked: state.symbol.is_some(),
                depth: nesting_depth(child, is_list_item),
            })),
            NodeValue::Code(_) => doc.spans.push(span(SpanKind::InlineCode)),
            NodeValue::Table(_) => doc.spans.push(span(SpanKind::Table)),
            NodeValue::Math(_) => doc.spans.push(span(SpanKind::Math)),
            NodeValue::FootnoteDefinition(_) | NodeValue::FootnoteReference(_) => {
                doc.spans.push(span(SpanKind::Footnote))
            }
            _ => {}
        }
    }
}

/// Resolve a Text node's content to its byte offset in the source. comrak
/// inline columns are unreliable around multi-byte characters (byte- vs
/// char-counted upstream), so both interpretations are tried and the one
/// that reproduces the node text verbatim wins. `None` when neither matches
/// (entity references, escapes) — callers must then skip rather than guess.
fn text_node_offset(text: &str, pos: &Sourcepos, lines: &LineIndex) -> Option<usize> {
    let line_start = *lines.starts.get(pos.start.line.checked_sub(1)?)?;
    let source = lines.source;
    let byte_cand = line_start + pos.start.column.checked_sub(1)?;
    if source.get(byte_cand..byte_cand + text.len()) == Some(text) {
        return Some(byte_cand);
    }
    let line_end = source[line_start..]
        .find('\n')
        .map_or(source.len(), |i| line_start + i);
    let line_text = &source[line_start..line_end];
    let char_cand = line_start
        + line_text
            .char_indices()
            .nth(pos.start.column.checked_sub(1)?)
            .map(|(i, _)| i)
            .unwrap_or(line_text.len());
    (source.get(char_cand..char_cand + text.len()) == Some(text)).then_some(char_cand)
}

/// Is `c` part of a tag name? Unicode letters/digits plus `-`, `_`, and the
/// nesting separator `/` (§3.3: `#tag`, `#area/sub`, Unicode allowed).
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '/')
}

/// Scan one inline Text node for the Loam syntax comrak leaves as plain text:
/// `#tag` occurrences and `![[...]]` embeds. Code never reaches here — code
/// content lives in `Code`/`CodeBlock` literals, not `Text` nodes — so code
/// exclusion holds by construction. Every candidate is verified against the
/// original source bytes before extraction; mismatches (escapes like
/// `\#tag`) are silently skipped, keeping the source authoritative.
fn scan_inline_text(text: &str, pos: &Sourcepos, lines: &LineIndex, doc: &mut ExtractedDoc) {
    let Some(node_start) = text_node_offset(text, pos, lines) else {
        return;
    };

    // Tags: `#` at start or after whitespace, followed by at least one
    // tag char that isn't purely numeric.
    let mut prev: Option<char> = None;
    let mut iter = text.char_indices().peekable();
    while let Some((offset, c)) = iter.next() {
        if c == '#' && prev.is_none_or(char::is_whitespace) {
            let name: String = text[offset + 1..]
                .chars()
                .take_while(|&c| is_tag_char(c))
                .collect();
            if !name.is_empty() && !name.chars().all(|c| c.is_ascii_digit()) {
                let range = SourceRange {
                    start: node_start + offset,
                    end: node_start + offset + 1 + name.len(),
                };
                doc.tags.push(TagRef { name, range });
                doc.spans.push(SyntaxSpan {
                    kind: SpanKind::Tag,
                    range,
                });
            }
            while iter.peek().is_some_and(|(_, c)| is_tag_char(*c)) {
                iter.next();
            }
        }
        prev = Some(c);
    }

    // Embeds: `![[inner]]` — comrak's wikilink extension skips the `!` form
    // entirely (the text survives verbatim), so it is parsed here.
    let mut search = 0;
    while let Some(found) = text[search..].find("![[") {
        let open = search + found;
        let inner_start = open + 3;
        match text[inner_start..].find("]]") {
            Some(close) => {
                let inner = &text[inner_start..inner_start + close];
                let end = inner_start + close + 2;
                let range = SourceRange {
                    start: node_start + open,
                    end: node_start + end,
                };
                let (target, alias) = match inner.split_once('|') {
                    Some((target, alias)) => (target, alias),
                    None => (inner, inner),
                };
                if target.trim().is_empty() {
                    doc.diagnostics.push(Diagnostic {
                        severity: Severity::Warning,
                        code: "empty-embed-target".into(),
                        message: "embed has an empty target".into(),
                        range,
                    });
                } else {
                    doc.links.push(LinkRef {
                        target: target.to_string(),
                        text: alias.to_string(),
                        style: LinkStyle::Wiki,
                        embed: true,
                        components: Some(wiki_components(target)),
                        range,
                    });
                    doc.spans.push(SyntaxSpan {
                        kind: SpanKind::Embed,
                        range,
                    });
                }
                search = end;
            }
            None => {
                doc.diagnostics.push(Diagnostic {
                    severity: Severity::Warning,
                    code: "unclosed-embed".into(),
                    message: "`![[` has no closing `]]`; left as plain text".into(),
                    range: SourceRange {
                        start: node_start + open,
                        end: node_start + text.len(),
                    },
                });
                break;
            }
        }
    }

    // Unclosed plain wikilinks: parsed `[[..]]` never survives as Text, so a
    // `[[` here without a later `]]` is a malformed delimiter (AC4) — the
    // text stays untouched and a diagnostic points at it.
    let mut search = 0;
    while let Some(found) = text[search..].find("[[") {
        let open = search + found;
        if text[..open].ends_with('!') {
            search = open + 2; // the embed scan above owns `![[`
            continue;
        }
        if text[open + 2..].contains("]]") {
            search = open + 2;
            continue;
        }
        doc.diagnostics.push(Diagnostic {
            severity: Severity::Warning,
            code: "unclosed-wikilink".into(),
            message: "`[[` has no closing `]]`; left as plain text".into(),
            range: SourceRange {
                start: node_start + open,
                end: node_start + text.len(),
            },
        });
        break;
    }
}

/// Extract ` ^block-id` suffixes (§3.4): ASCII alphanumerics/dashes at end of
/// line, preceded by whitespace, outside code and frontmatter.
fn extract_block_ids(source: &str, doc: &mut ExtractedDoc) {
    let excluded: Vec<SourceRange> = doc
        .spans
        .iter()
        .filter(|s| {
            matches!(
                s.kind,
                SpanKind::CodeBlock { .. }
                    | SpanKind::InlineCode
                    | SpanKind::Frontmatter
                    | SpanKind::Math
                    | SpanKind::Comment
            )
        })
        .map(|s| s.range)
        .collect();

    let mut line_start = 0;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if let Some(caret) = trimmed.rfind('^') {
            let id = &trimmed[caret + 1..];
            let preceded_by_space = trimmed[..caret].ends_with(char::is_whitespace);
            let valid_id =
                !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
            let range = SourceRange {
                start: line_start + caret,
                end: line_start + caret + 1 + id.len(),
            };
            let in_excluded = excluded
                .iter()
                .any(|ex| ex.start <= range.start && range.end <= ex.end);
            if preceded_by_space && valid_id && !in_excluded {
                doc.blocks.push(BlockRef {
                    id: id.to_string(),
                    range,
                });
                doc.spans.push(SyntaxSpan {
                    kind: SpanKind::BlockId,
                    range,
                });
            }
        }
        line_start += line.len();
    }
}

/// Structural diagnostics over the extracted model. Warnings only — parsing
/// is total and the source is untouched.
fn diagnose(source: &str, doc: &mut ExtractedDoc) {
    for link in &doc.links {
        if link.target.trim().is_empty() {
            doc.diagnostics.push(Diagnostic {
                severity: Severity::Warning,
                code: "empty-link-target".into(),
                message: "link has an empty target".into(),
                range: link.range,
            });
        }
    }
    // `---` opener on line 1 with no closing delimiter: comrak yields no
    // frontmatter node and the text silently reads as a thematic break /
    // body text. Surface that so the properties UI can explain itself.
    let opens_frontmatter = source.lines().next().is_some_and(|l| l.trim_end() == "---");
    if opens_frontmatter && doc.raw_frontmatter.is_none() && source.lines().count() > 1 {
        doc.diagnostics.push(Diagnostic {
            severity: Severity::Warning,
            code: "unterminated-frontmatter".into(),
            message: "`---` on the first line is not closed; frontmatter was not parsed".into(),
            range: SourceRange {
                start: 0,
                end: source.lines().next().map(str::len).unwrap_or(0),
            },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASELINE: &str = "---\ntitle: Baseline\n---\n\n# Hello *world*\n\nA [link](https://example.com) and [[Target Note|shown]] and `code`.\n\n- [x] done task\n- [ ] open task\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n\n> quoted\n\nStrike ~~this~~ and a footnote[^1].\n\n[^1]: the note\n";

    fn slice(source: &str, range: SourceRange) -> &str {
        &source[range.start..range.end]
    }

    /// AC1: the CommonMark + GFM + §3.3 baseline parses deterministically —
    /// identical extractions on repeated parses, with the expected structure.
    #[test]
    fn baseline_parses_deterministically() {
        let first = parse(BASELINE);
        for _ in 0..3 {
            assert_eq!(parse(BASELINE), first, "parse must be deterministic");
        }

        assert_eq!(first.headings.len(), 1);
        assert_eq!(first.headings[0].level, 1);
        assert_eq!(first.headings[0].text, "Hello world");

        let targets: Vec<(&str, LinkStyle)> = first
            .links
            .iter()
            .map(|l| (l.target.as_str(), l.style))
            .collect();
        assert_eq!(
            targets,
            vec![
                ("https://example.com", LinkStyle::Markdown),
                ("Target Note", LinkStyle::Wiki),
            ]
        );
        assert_eq!(first.links[1].text, "shown", "title after pipe (Obsidian)");

        assert!(
            first
                .raw_frontmatter
                .as_deref()
                .is_some_and(|f| f.contains("title: Baseline")),
            "frontmatter captured raw: {:?}",
            first.raw_frontmatter
        );

        let kind_count =
            |pred: fn(&SpanKind) -> bool| first.spans.iter().filter(|s| pred(&s.kind)).count();
        assert_eq!(kind_count(|k| matches!(k, SpanKind::Task { .. })), 2);
        assert_eq!(
            kind_count(|k| matches!(k, SpanKind::Task { checked: true, .. })),
            1
        );
        assert_eq!(kind_count(|k| matches!(k, SpanKind::Table)), 1);
        assert_eq!(kind_count(|k| matches!(k, SpanKind::Strikethrough)), 1);
        assert_eq!(kind_count(|k| matches!(k, SpanKind::InlineCode)), 1);
        assert_eq!(kind_count(|k| matches!(k, SpanKind::CodeBlock { .. })), 1);
        assert_eq!(kind_count(|k| matches!(k, SpanKind::Blockquote { .. })), 1);
        assert!(kind_count(|k| matches!(k, SpanKind::Footnote)) >= 2);
        assert!(first.diagnostics.is_empty(), "{:?}", first.diagnostics);
    }

    /// AC2: ranges are stable byte offsets into the ORIGINAL source — slicing
    /// the source at a range yields exactly the construct's text.
    #[test]
    fn ranges_point_into_the_original_source() {
        let doc = parse(BASELINE);
        assert_eq!(
            slice(BASELINE, doc.headings[0].range).trim_end(),
            "# Hello *world*"
        );
        assert_eq!(
            slice(BASELINE, doc.links[0].range),
            "[link](https://example.com)"
        );
        assert_eq!(slice(BASELINE, doc.links[1].range), "[[Target Note|shown]]");
        let code = doc
            .spans
            .iter()
            .find(|s| matches!(s.kind, SpanKind::CodeBlock { .. }))
            .expect("code block span");
        assert_eq!(
            slice(BASELINE, code.range).trim_end(),
            "```rust\nfn main() {}\n```"
        );
        assert!(matches!(
            &code.kind,
            SpanKind::CodeBlock { language: Some(lang) } if lang == "rust"
        ));
        for span in &doc.spans {
            assert!(span.range.start <= span.range.end);
            assert!(span.range.end <= BASELINE.len());
            assert!(BASELINE.is_char_boundary(span.range.start));
            assert!(BASELINE.is_char_boundary(span.range.end));
        }
    }

    /// AC2: the model serializes (camelCase, adjacently-tagged span kinds) and
    /// round-trips losslessly.
    #[test]
    fn model_serializes_and_round_trips() {
        let doc = parse(BASELINE);
        let json = serde_json::to_string_pretty(&doc).expect("serializes");
        assert!(json.contains("\"rawFrontmatter\""), "camelCase fields");
        assert!(json.contains("\"kind\": \"heading\""), "tagged span kinds");
        assert!(json.contains("\"start\""));
        let back: ExtractedDoc = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(back, doc, "lossless round-trip");
    }

    /// Multi-byte characters: ranges are byte offsets that respect UTF-8
    /// boundaries (NFC vaults are full of them).
    #[test]
    fn multibyte_sources_produce_valid_ranges() {
        let source = "# Café ☕\n\nSee [[Résumé]] and [émoji](https://e.example) 🎈.\n";
        let doc = parse(source);
        assert_eq!(doc.headings[0].text, "Café ☕");
        assert_eq!(slice(source, doc.links[0].range), "[[Résumé]]");
        for span in &doc.spans {
            assert!(source.is_char_boundary(span.range.start));
            assert!(source.is_char_boundary(span.range.end));
        }
    }

    /// AC3: malformed constructs yield structured diagnostics — and never a
    /// panic or altered source.
    #[test]
    fn malformed_syntax_yields_diagnostics() {
        let unterminated = "---\ntitle: never closed\n\n# Body\n";
        let doc = parse(unterminated);
        assert!(doc.raw_frontmatter.is_none());
        assert!(
            doc.diagnostics
                .iter()
                .any(|d| d.code == "unterminated-frontmatter"),
            "{:?}",
            doc.diagnostics
        );

        let empty_target = "[click]()\n";
        let doc = parse(empty_target);
        assert!(
            doc.diagnostics
                .iter()
                .any(|d| d.code == "empty-link-target"),
            "{:?}",
            doc.diagnostics
        );
        assert_eq!(slice(empty_target, doc.diagnostics[0].range), "[click]()");
    }

    /// AC3: parsing is total — a pile of hostile inputs, none may panic.
    #[test]
    fn hostile_inputs_do_not_panic() {
        let cases = [
            "",
            "\n",
            "\u{0}",
            "---",
            "---\n",
            "[[",
            "[[]]",
            "[](",
            "```",
            "```rust\nfn broken(",
            "> > > > >",
            "| | |\n|",
            "# \u{feff}",
            "[^1]",
            "*_*_~~`",
            "\\\\\\\\",
            "- [x",
            "$$\\frac{",
            "====",
            "==",
            "== ==",
            "==a==b==",
            "%%",
            "%%%%",
            "%%a",
            "\\==\\%%",
            "> [!",
            "> [!note]-",
            "> [!x]+ ==%%",
        ];
        for case in cases {
            let doc = parse(case);
            for span in &doc.spans {
                assert!(span.range.end <= case.len(), "range in bounds for {case:?}");
            }
        }
        // Deep nesting must not blow the stack (comrak caps nesting depth).
        let deep = "> ".repeat(5_000) + "end";
        parse(&deep);
        let brackets = "[".repeat(10_000);
        parse(&brackets);
    }

    proptest::proptest! {
        /// AC3 (fuzz): parse is total over arbitrary input — no panics, and
        /// every produced range stays in bounds on char boundaries.
        #[test]
        fn arbitrary_input_never_panics(source in proptest::string::string_regex(
            "(?s)[-#*>\\[\\]()|`~^$%={}:\\\\\\n a-zA-Z0-9é☕]{0,400}"
        ).expect("regex")) {
            let doc = parse(&source);
            for span in &doc.spans {
                proptest::prop_assert!(span.range.end <= source.len());
                proptest::prop_assert!(source.is_char_boundary(span.range.start));
                proptest::prop_assert!(source.is_char_boundary(span.range.end));
            }
            for diagnostic in &doc.diagnostics {
                proptest::prop_assert!(diagnostic.range.end <= source.len());
            }
        }
    }

    /// AC4: parser configuration exists in exactly one place — this module.
    /// Any second `Options` construction or `parse_document` call site in the
    /// crate is a fork and fails this scan.
    #[test]
    fn parser_configuration_has_a_single_site() {
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut option_sites = Vec::new();
        let mut parse_sites = Vec::new();
        let mut stack = vec![src_root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("readable src") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).expect("source");
                    if text.contains("Options::default()") {
                        option_sites.push(path.clone());
                    }
                    if text.contains("parse_document(") {
                        parse_sites.push(path.clone());
                    }
                }
            }
        }
        assert_eq!(
            option_sites,
            vec![
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("src")
                    .join("parse")
                    .join("mod.rs")
            ],
            "comrak options must be configured only in parse/mod.rs"
        );
        assert_eq!(option_sites.len(), 1, "single Options site");
        assert_eq!(parse_sites.len(), 1, "single parse_document site");
    }
}
