//! Internal-link resolution (LOA-94, §3.4).
//!
//! One implementation serves editor navigation, backlinks, and — later —
//! embeds, so a link means the same thing everywhere. The order is copied
//! from §3.4 verbatim and is case-insensitive throughout:
//!
//! 1. exact vault-relative path,
//! 2. unique filename anywhere in the vault,
//! 3. frontmatter alias.
//!
//! Ambiguity is never resolved silently. When a name matches more than one
//! note the caller gets every candidate, ranked nearest-path-first, and
//! decides — that is what lets the editor draw a squiggle and offer a
//! quick-fix instead of guessing wrong.

mod resolve;

pub use resolve::{
    Candidate, LinkTarget, MatchKind, Resolution, VaultEntry, resolve_link, resolve_target,
};
