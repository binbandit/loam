use serde::{Deserialize, Serialize};

use crate::parse::{LinkRef, LinkStyle};

/// One note the resolver can see: its path plus the aliases it declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultEntry {
    /// NFC vault-relative path, e.g. `Projects/Loam.md`.
    pub path: String,
    /// Frontmatter `aliases`, in declaration order.
    pub aliases: Vec<String>,
}

impl VaultEntry {
    pub fn new(
        path: impl Into<String>,
        aliases: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            path: path.into(),
            aliases: aliases.into_iter().map(Into::into).collect(),
        }
    }
}

/// Which §3.4 rule produced a match. Ordering is the precedence order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchKind {
    /// The target named the note's vault-relative path.
    ExactPath,
    /// The target named a filename that exists exactly once in the vault.
    Filename,
    /// The target named a frontmatter alias.
    Alias,
}

/// A note the target could mean, with the rule that matched it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub kind: MatchKind,
}

/// What a link target points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Resolution {
    /// Exactly one note. `heading`/`block` carry the fragment as written.
    #[serde(rename_all = "camelCase")]
    Resolved {
        path: String,
        kind: MatchKind,
        heading: Option<String>,
        block: Option<String>,
    },
    /// Several notes match the same rule. Ranked nearest-path first; the
    /// caller warns instead of picking (§3.4).
    #[serde(rename_all = "camelCase")]
    Ambiguous { candidates: Vec<Candidate> },
    /// Nothing in the vault matches — the link is unresolved, which is a
    /// normal state a note can be created from (LOA-103).
    #[serde(rename_all = "camelCase")]
    Unresolved,
    /// Not an internal link at all (`https:`, `mailto:`, …).
    #[serde(rename_all = "camelCase")]
    External,
}

/// A link target split into the note and its fragment.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LinkTarget {
    pub note: String,
    pub heading: Option<String>,
    pub block: Option<String>,
}

/// Schemes that are somebody else's problem (the OS browser's, §3.4).
fn is_external(target: &str) -> bool {
    let lower = target.trim().to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("obsidian://")
        || lower.starts_with("loam://")
        || lower.starts_with("//")
}

/// Splits `Note#Heading` / `Note#^block` and undoes `%20`-style escaping,
/// so a Markdown link written by another tool resolves like a wikilink.
pub fn parse_target(target: &str) -> LinkTarget {
    let trimmed = target.trim();
    let (note, fragment) = match trimmed.split_once('#') {
        Some((note, fragment)) => (note, Some(fragment)),
        None => (trimmed, None),
    };
    let (heading, block) = match fragment {
        Some(fragment) => match fragment.strip_prefix('^') {
            Some(block) => (None, Some(decode(block))),
            None if fragment.is_empty() => (None, None),
            None => (Some(decode(fragment)), None),
        },
        None => (None, None),
    };
    LinkTarget {
        note: decode(note),
        heading,
        block,
    }
}

/// Minimal percent-decoding: Markdown links commonly escape spaces.
fn decode(text: &str) -> String {
    if !text.contains('%') {
        return text.trim().to_string();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).trim().to_string()
}

/// Case-insensitive comparison. Vault paths are NFC (§5.6), so a byte-wise
/// ASCII-plus-Unicode lowercase is enough here.
fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `Projects/Loam.md` → `Loam`.
fn stem(path: &str) -> &str {
    let file = path.rsplit('/').next().unwrap_or(path);
    file.strip_suffix(".md")
        .or_else(|| file.strip_suffix(".MD"))
        .unwrap_or(file)
}

/// A target may or may not carry the extension; both spell the same note.
fn path_matches(entry_path: &str, target: &str) -> bool {
    let target = target.trim_start_matches("./").trim_start_matches('/');
    if same(entry_path, target) {
        return true;
    }
    match entry_path
        .strip_suffix(".md")
        .or_else(|| entry_path.strip_suffix(".MD"))
    {
        Some(without) => same(without, target),
        None => false,
    }
}

/// How many leading directory segments two paths share. Higher is nearer.
fn shared_depth(a: &str, b: &str) -> usize {
    let left: Vec<&str> = a.split('/').collect();
    let right: Vec<&str> = b.split('/').collect();
    let limit = left
        .len()
        .saturating_sub(1)
        .min(right.len().saturating_sub(1));
    (0..limit)
        .take_while(|index| same(left[*index], right[*index]))
        .count()
}

/// Orders candidates by §3.4's nearest-path heuristic: most shared folders
/// with the linking note first, then the shallowest path, then
/// alphabetically so the answer is stable across runs and platforms.
fn rank(candidates: &mut [Candidate], from: &str) {
    candidates.sort_by(|a, b| {
        shared_depth(&b.path, from)
            .cmp(&shared_depth(&a.path, from))
            .then_with(|| {
                a.path
                    .matches('/')
                    .count()
                    .cmp(&b.path.matches('/').count())
            })
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
}

fn finish(mut matches: Vec<Candidate>, from: &str, target: &LinkTarget) -> Option<Resolution> {
    match matches.len() {
        0 => None,
        1 => {
            let only = matches.remove(0);
            Some(Resolution::Resolved {
                path: only.path,
                kind: only.kind,
                heading: target.heading.clone(),
                block: target.block.clone(),
            })
        }
        _ => {
            rank(&mut matches, from);
            Some(Resolution::Ambiguous {
                candidates: matches,
            })
        }
    }
}

/// Resolves a target string against the vault, from the note at `from`.
///
/// `from` only affects *ordering* of ambiguous candidates — never whether a
/// link resolves — so the same link means the same note everywhere.
pub fn resolve_target(target: &str, from: &str, vault: &[VaultEntry]) -> Resolution {
    if is_external(target) {
        return Resolution::External;
    }
    let parsed = parse_target(target);
    if parsed.note.is_empty() {
        // `[[#Heading]]`: a fragment inside the current note.
        return Resolution::Resolved {
            path: from.to_string(),
            kind: MatchKind::ExactPath,
            heading: parsed.heading.clone(),
            block: parsed.block.clone(),
        };
    }

    // 1. Exact vault-relative path.
    let by_path: Vec<Candidate> = vault
        .iter()
        .filter(|entry| path_matches(&entry.path, &parsed.note))
        .map(|entry| Candidate {
            path: entry.path.clone(),
            kind: MatchKind::ExactPath,
        })
        .collect();
    if let Some(resolution) = finish(by_path, from, &parsed) {
        return resolution;
    }

    // 2. Filename anywhere in the vault. Only a *bare* name may match this
    //    way; `Foo/Bar` is a path that simply did not exist.
    if !parsed.note.contains('/') {
        let by_name: Vec<Candidate> = vault
            .iter()
            .filter(|entry| same(stem(&entry.path), &parsed.note))
            .map(|entry| Candidate {
                path: entry.path.clone(),
                kind: MatchKind::Filename,
            })
            .collect();
        if let Some(resolution) = finish(by_name, from, &parsed) {
            return resolution;
        }
    }

    // 3. Frontmatter alias.
    let by_alias: Vec<Candidate> = vault
        .iter()
        .filter(|entry| entry.aliases.iter().any(|alias| same(alias, &parsed.note)))
        .map(|entry| Candidate {
            path: entry.path.clone(),
            kind: MatchKind::Alias,
        })
        .collect();
    if let Some(resolution) = finish(by_alias, from, &parsed) {
        return resolution;
    }

    Resolution::Unresolved
}

/// Resolves an extracted link. Wiki and Markdown links go through the same
/// engine (AC5): only the spelling differs, never the meaning.
pub fn resolve_link(link: &LinkRef, from: &str, vault: &[VaultEntry]) -> Resolution {
    match (&link.components, link.style) {
        (Some(components), LinkStyle::Wiki) => {
            if components.note.is_empty()
                && components.heading.is_none()
                && components.block.is_none()
            {
                return Resolution::Unresolved;
            }
            let target = LinkTarget {
                note: components.note.clone(),
                heading: components.heading.clone(),
                block: components.block.clone(),
            };
            resolve_parsed(&target, from, vault)
        }
        _ => resolve_target(&link.target, from, vault),
    }
}

/// Resolution for an already-split target (the wiki path, where the parser
/// has done the splitting and its spelling is authoritative).
fn resolve_parsed(target: &LinkTarget, from: &str, vault: &[VaultEntry]) -> Resolution {
    let rebuilt = match (&target.heading, &target.block) {
        (Some(heading), _) => format!("{}#{heading}", target.note),
        (_, Some(block)) => format!("{}#^{block}", target.note),
        _ => target.note.clone(),
    };
    resolve_target(&rebuilt, from, vault)
}
