//! Custom Loam Markdown extensions (§3.3, D4, LOA-51): `==highlight==`,
//! `%%comment%%`, and `> [!type] Title` callout normalization. All of it
//! layers ON TOP of the single comrak configuration — a plain source-scan
//! pass plus blockquote inspection, never a second grammar. Comments are
//! hidden at render time only; the source is never altered.

use super::model::{
    CalloutFold, Diagnostic, ExtractedDoc, Severity, SourceRange, SpanKind, SyntaxSpan,
};

/// The P0 callout set (§3.3, Obsidian-compatible).
const CALLOUT_TYPES: [&str; 13] = [
    "note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure",
    "danger", "bug", "example", "quote",
];

/// §3.3 aliases → canonical type.
fn resolve_alias(lowered: &str) -> &str {
    match lowered {
        "summary" | "tldr" => "abstract",
        "hint" | "important" => "tip",
        "check" | "done" => "success",
        "help" | "faq" => "question",
        "caution" | "attention" => "warning",
        "fail" | "missing" => "failure",
        "error" => "danger",
        "cite" => "quote",
        other => other,
    }
}

/// Parsed `[!type]±(space)Title` callout header.
pub(super) struct CalloutHeader {
    pub callout_type: String,
    pub title: Option<String>,
    pub fold: Option<CalloutFold>,
    pub custom: bool,
}

/// Inspect a blockquote's source slice for a callout header. The slice
/// starts at the quote's own `>` marker; nested quotes re-enter here with
/// their inner slice.
pub(super) fn callout_header(quote_slice: &str) -> Option<CalloutHeader> {
    let first_line = quote_slice.lines().next()?;
    let content = first_line.trim_start_matches(['>', ' ', '\t']);
    let inner = content.strip_prefix("[!")?;
    let close = inner.find(']')?;
    let raw_type = &inner[..close];
    if raw_type.is_empty() || !raw_type.chars().all(|c| c.is_alphanumeric() || c == '-') {
        return None;
    }
    let mut rest = &inner[close + 1..];
    let fold = match rest.as_bytes().first() {
        Some(b'-') => {
            rest = &rest[1..];
            Some(CalloutFold::Folded)
        }
        Some(b'+') => {
            rest = &rest[1..];
            Some(CalloutFold::Expanded)
        }
        _ => None,
    };
    let title = rest.trim();
    let lowered = raw_type.to_lowercase();
    let callout_type = resolve_alias(&lowered).to_string();
    Some(CalloutHeader {
        custom: !CALLOUT_TYPES.contains(&callout_type.as_str()),
        callout_type,
        title: (!title.is_empty()).then(|| title.to_string()),
        fold,
    })
}

/// Ranges (code, frontmatter, math) that inline extensions must not enter.
fn exclusion_ranges(doc: &ExtractedDoc) -> Vec<SourceRange> {
    doc.spans
        .iter()
        .filter(|s| {
            matches!(
                s.kind,
                SpanKind::CodeBlock { .. }
                    | SpanKind::InlineCode
                    | SpanKind::Frontmatter
                    | SpanKind::Math
            )
        })
        .map(|s| s.range)
        .collect()
}

fn inside(ranges: &[SourceRange], range: SourceRange) -> bool {
    ranges
        .iter()
        .any(|ex| ex.start <= range.start && range.end <= ex.end)
}

/// Find the next unescaped `delimiter` at or after `from`, skipping excluded
/// ranges. Escaped means an odd run of `\` immediately before it.
fn find_delimiter(
    source: &str,
    delimiter: &str,
    from: usize,
    excluded: &[SourceRange],
) -> Option<usize> {
    let mut search = from;
    while let Some(found) = source[search..].find(delimiter) {
        let at = search + found;
        let range = SourceRange {
            start: at,
            end: at + delimiter.len(),
        };
        let backslashes = source[..at]
            .bytes()
            .rev()
            .take_while(|&b| b == b'\\')
            .count();
        if backslashes % 2 == 1 || inside(excluded, range) {
            search = at + delimiter.len();
            continue;
        }
        return Some(at);
    }
    None
}

/// Extract `%%comments%%` and `==highlights==`, then suppress index-relevant
/// items (tags, links, block spans) that fall inside comments.
///
/// Rules gated by the corpus:
/// - Comments may span lines and paragraphs; an unclosed `%%` comments out
///   the rest of the note (with a diagnostic).
/// - Highlights close on the same paragraph — a blank line voids an open
///   `==`; the delimiters then remain literal text.
/// - Escaped delimiters (`\==`, `\%%`) are always literal.
pub(super) fn extract_inline_extensions(source: &str, doc: &mut ExtractedDoc) {
    let excluded = exclusion_ranges(doc);

    // Comments first: their ranges also exclude highlights.
    let mut comments: Vec<SourceRange> = Vec::new();
    let mut at = 0;
    while let Some(open) = find_delimiter(source, "%%", at, &excluded) {
        match find_delimiter(source, "%%", open + 2, &excluded) {
            Some(close) => {
                let range = SourceRange {
                    start: open,
                    end: close + 2,
                };
                comments.push(range);
                doc.spans.push(SyntaxSpan {
                    kind: SpanKind::Comment,
                    range,
                });
                at = close + 2;
            }
            None => {
                let range = SourceRange {
                    start: open,
                    end: source.len(),
                };
                comments.push(range);
                doc.spans.push(SyntaxSpan {
                    kind: SpanKind::Comment,
                    range,
                });
                doc.diagnostics.push(Diagnostic {
                    severity: Severity::Warning,
                    code: "unclosed-comment".into(),
                    message: "`%%` has no closing `%%`; the rest of the note is a comment".into(),
                    range,
                });
                break;
            }
        }
    }

    // Highlights: `==` pairs within one paragraph, non-empty, not blank
    // immediately after the opener (`== ==` is not a highlight).
    let blocked: Vec<SourceRange> = excluded.iter().chain(comments.iter()).copied().collect();
    let mut at = 0;
    while let Some(open) = find_delimiter(source, "==", at, &blocked) {
        let Some(close) = find_delimiter(source, "==", open + 2, &blocked) else {
            break;
        };
        let inner = &source[open + 2..close];
        if inner.trim().is_empty() || inner.contains("\n\n") {
            // Empty or crossing a paragraph boundary: literal text. Restart
            // after the opener so a later `==…==` can still match.
            at = open + 2;
            continue;
        }
        let range = SourceRange {
            start: open,
            end: close + 2,
        };
        doc.spans.push(SyntaxSpan {
            kind: SpanKind::Highlight,
            range,
        });
        at = close + 2;
    }

    // Comments hide their content from the index: drop extracted tags,
    // links, and blocks inside any comment. Style spans stay (edit modes dim
    // the region, so inner decorations remain meaningful).
    if !comments.is_empty() {
        doc.tags.retain(|t| !inside(&comments, t.range));
        doc.links.retain(|l| !inside(&comments, l.range));
        doc.blocks.retain(|b| !inside(&comments, b.range));
        doc.spans.retain(|s| {
            !matches!(
                s.kind,
                SpanKind::Tag | SpanKind::Wikilink | SpanKind::Embed | SpanKind::Link
            ) || !inside(&comments, s.range)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callout_headers_normalize_types_and_aliases() {
        for (input, expected, custom) in [
            ("> [!note] Title", "note", false),
            ("> [!NOTE]", "note", false),
            ("> [!summary] S", "abstract", false),
            ("> [!tldr]", "abstract", false),
            ("> [!hint]", "tip", false),
            ("> [!important]", "tip", false),
            ("> [!check]", "success", false),
            ("> [!done]", "success", false),
            ("> [!help]", "question", false),
            ("> [!faq]", "question", false),
            ("> [!caution]", "warning", false),
            ("> [!attention]", "warning", false),
            ("> [!fail]", "failure", false),
            ("> [!missing]", "failure", false),
            ("> [!error]", "danger", false),
            ("> [!cite]", "quote", false),
            ("> [!my-custom-type] X", "my-custom-type", true),
        ] {
            let header = callout_header(input).unwrap_or_else(|| panic!("{input} parses"));
            assert_eq!(header.callout_type, expected, "{input}");
            assert_eq!(header.custom, custom, "{input}");
        }
        for canonical in CALLOUT_TYPES {
            let header = callout_header(&format!("> [!{canonical}] T")).expect("canonical");
            assert_eq!(header.callout_type, canonical);
            assert!(!header.custom);
        }
    }

    #[test]
    fn callout_headers_parse_fold_and_title() {
        let folded = callout_header("> [!note]- Collapsed title").expect("parses");
        assert_eq!(folded.fold, Some(CalloutFold::Folded));
        assert_eq!(folded.title.as_deref(), Some("Collapsed title"));

        let expanded = callout_header("> [!tip]+").expect("parses");
        assert_eq!(expanded.fold, Some(CalloutFold::Expanded));
        assert_eq!(expanded.title, None);

        assert!(callout_header("> plain quote").is_none());
        assert!(callout_header("> [!]").is_none(), "empty type");
        assert!(callout_header("> [!has space]").is_none(), "invalid type");
        assert!(callout_header("> [!unclosed").is_none());
    }
}
