//! Typed YAML frontmatter extraction (§3.7, LOA-47). The raw bytes are
//! always preserved by the caller; this module only produces a typed VIEW —
//! malformed YAML yields a diagnostic and no view, never data loss.

use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use super::model::{
    Diagnostic, ExtractedDoc, Frontmatter, Property, PropertyValue, Severity, SourceRange,
};

/// Parse the comrak-provided raw frontmatter block (delimiters included,
/// located at `node_range` in the source) into the typed model.
pub(super) fn extract_frontmatter(raw: &str, node_range: SourceRange, doc: &mut ExtractedDoc) {
    let Some((inner, inner_offset)) = strip_delimiters(raw) else {
        return; // comrak guarantees delimiters; nothing to type otherwise
    };

    let parsed = match YamlLoader::load_from_str(inner) {
        Ok(docs) => docs,
        Err(error) => {
            let marker = error.marker();
            let at = (inner_offset + marker.index()).min(raw.len());
            doc.diagnostics.push(Diagnostic {
                severity: Severity::Warning,
                code: "frontmatter-parse-error".into(),
                message: format!("Frontmatter could not be parsed: {error}"),
                range: SourceRange {
                    start: node_range.start + at.min(raw.len()),
                    end: node_range.end,
                },
            });
            return;
        }
    };

    let Some(Yaml::Hash(hash)) = parsed.first() else {
        if parsed.first().is_some_and(|y| !matches!(y, Yaml::Null)) {
            doc.diagnostics.push(Diagnostic {
                severity: Severity::Warning,
                code: "frontmatter-not-a-mapping".into(),
                message: "Frontmatter is valid YAML but not a key/value mapping".into(),
                range: node_range,
            });
        }
        return;
    };

    // Key lines in document order: yaml-rust2's hash preserves insertion
    // order, so hash entries and unindented `key:` lines zip 1:1. Each
    // property's range runs from its key line to the next key line (or the
    // end of the block), covering multi-line values.
    let key_line_offsets: Vec<usize> = {
        let mut offsets = Vec::new();
        let mut at = inner_offset;
        for line in inner.split_inclusive('\n') {
            let is_key_line = line
                .chars()
                .next()
                .is_some_and(|c| !c.is_whitespace() && c != '#' && c != '-')
                && line.contains(':');
            if is_key_line {
                offsets.push(at);
            }
            at += line.len();
        }
        offsets
    };

    let mut frontmatter = Frontmatter::default();
    for (index, (key, value)) in hash.iter().enumerate() {
        let key = scalar_to_string(key);
        let start = key_line_offsets.get(index).copied().unwrap_or(0);
        let end = key_line_offsets
            .get(index + 1)
            .copied()
            .unwrap_or(inner_offset + inner.len());
        let range = if key_line_offsets.len() == hash.len() {
            SourceRange {
                start: node_range.start + start,
                end: node_range.start + raw[..end].trim_end().len().max(start),
            }
        } else {
            node_range // defensive: unusual YAML where lines and keys diverge
        };

        match key.as_str() {
            "tags" => frontmatter.tags = string_list(value, true),
            "aliases" => frontmatter.aliases = string_list(value, false),
            _ => {}
        }
        frontmatter.properties.push(Property {
            key,
            value: typed_value(value),
            range,
        });
    }
    doc.frontmatter = Some(frontmatter);
}

/// Split `---\n…\n---` into the inner YAML and its byte offset within `raw`.
fn strip_delimiters(raw: &str) -> Option<(&str, usize)> {
    let after_open = raw.strip_prefix("---")?;
    let after_newline = after_open
        .strip_prefix("\r\n")
        .or(after_open.strip_prefix('\n'))?;
    let inner_offset = raw.len() - after_newline.len();
    let trimmed = after_newline.trim_end();
    let inner = trimmed
        .strip_suffix("---")
        .map(|i| i.trim_end_matches(['\r', '\n']))
        .unwrap_or(trimmed);
    Some((inner, inner_offset))
}

fn scalar_to_string(yaml: &Yaml) -> String {
    match yaml {
        Yaml::String(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(r) => r.clone(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null => String::new(),
        other => emit_yaml(other),
    }
}

/// Last-resort representation for values outside the §3.7 type set (nested
/// maps and friends): re-emitted YAML text — visible and editable, not lost.
fn emit_yaml(yaml: &Yaml) -> String {
    let mut out = String::new();
    let mut emitter = YamlEmitter::new(&mut out);
    if emitter.dump(yaml).is_err() {
        return String::new();
    }
    out.strip_prefix("---\n").unwrap_or(&out).trim().to_string()
}

/// Is this string a `YYYY-MM-DD` date, optionally extended into a datetime
/// (`YYYY-MM-DDTHH:MM…` / `YYYY-MM-DD HH:MM…`)?
fn classify_text(s: &str) -> PropertyValue {
    let bytes = s.as_bytes();
    let is_date_prefix = bytes.len() >= 10
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !is_date_prefix {
        return PropertyValue::Text(s.to_string());
    }
    match &bytes[10..] {
        [] => PropertyValue::Date(s.to_string()),
        [b'T' | b' ', rest @ ..] if rest.len() >= 4 => PropertyValue::Datetime(s.to_string()),
        _ => PropertyValue::Text(s.to_string()),
    }
}

fn typed_value(yaml: &Yaml) -> PropertyValue {
    match yaml {
        Yaml::String(s) => classify_text(s),
        Yaml::Integer(i) => PropertyValue::Number(*i as f64),
        Yaml::Real(r) => r
            .parse()
            .map(PropertyValue::Number)
            .unwrap_or_else(|_| PropertyValue::Text(r.clone())),
        Yaml::Boolean(b) => PropertyValue::Checkbox(*b),
        Yaml::Null => PropertyValue::Empty,
        Yaml::Array(items) => PropertyValue::List(items.iter().map(typed_value).collect()),
        other => PropertyValue::Text(emit_yaml(other)),
    }
}

/// Reserved-key helper: a list of strings, or a single string, becomes a
/// `Vec<String>`. Tags additionally drop a leading `#` (both spellings are
/// common in the wild).
fn string_list(yaml: &Yaml, strip_hash: bool) -> Vec<String> {
    let normalize = |s: String| {
        if strip_hash {
            s.strip_prefix('#').map(str::to_string).unwrap_or(s)
        } else {
            s
        }
    };
    match yaml {
        Yaml::Array(items) => items
            .iter()
            .map(scalar_to_string)
            .filter(|s| !s.is_empty())
            .map(normalize)
            .collect(),
        Yaml::Null => Vec::new(),
        single => {
            let s = scalar_to_string(single);
            if s.is_empty() {
                Vec::new()
            } else {
                vec![normalize(s)]
            }
        }
    }
}
