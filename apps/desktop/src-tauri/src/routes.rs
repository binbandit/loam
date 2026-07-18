//! Vault-open entry routes (LOA-48, §3.1): folder picker, drag-drop, CLI
//! argument, and `loam://open` all normalize into one typed request that ends
//! in `windows::open_or_focus`. Every input is untrusted; the shell validates
//! paths with metadata calls only and never reads vault file contents (that is
//! `loam-core`'s job behind typed E06 commands).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::windows::{self, VaultInfo};

/// Stable, serializable error codes shared by every entry route (AC2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum OpenError {
    EmptyInput,
    RelativePath,
    NotAccessible,
    NotAFolder,
    InvalidUri,
    UnsupportedUriAction,
    WindowFailed,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            OpenError::EmptyInput => "no path was provided",
            OpenError::RelativePath => "vault paths must be absolute",
            OpenError::NotAccessible => "the path does not exist or is not accessible",
            OpenError::NotAFolder => "the path is not a folder",
            OpenError::InvalidUri => "the URI could not be parsed",
            OpenError::UnsupportedUriAction => "only loam://open is supported at M0",
            OpenError::WindowFailed => "the vault window could not be created",
        };
        f.write_str(message)
    }
}

/// Normalize any filesystem-path input (picker result, dropped folder, CLI
/// argument) into a canonical vault root. One code path for every route (AC1);
/// canonicalization resolves symlinks, `..`, trailing separators, and — on
/// macOS — the filesystem's Unicode normalization form (AC3).
pub fn normalize_path_input(input: &str) -> Result<PathBuf, OpenError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(OpenError::EmptyInput);
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(OpenError::RelativePath);
    }
    let canonical = path.canonicalize().map_err(|_| OpenError::NotAccessible)?;
    if !canonical.is_dir() {
        return Err(OpenError::NotAFolder);
    }
    Ok(canonical)
}

/// Parse `loam://open?path=<percent-encoded absolute path>` (M0 plumbing; the
/// full action surface is the P1 URI story). Anything else is a stable error.
pub fn parse_loam_uri(input: &str) -> Result<PathBuf, OpenError> {
    let url = tauri::Url::parse(input.trim()).map_err(|_| OpenError::InvalidUri)?;
    if url.scheme() != "loam" {
        return Err(OpenError::InvalidUri);
    }
    // `loam://open?...` parses with host "open"; `loam:open` (no authority)
    // puts it in the path. Accept exactly the action "open".
    let action = url
        .host_str()
        .unwrap_or_else(|| url.path().trim_start_matches('/'));
    if action != "open" {
        return Err(OpenError::UnsupportedUriAction);
    }
    let path = url
        .query_pairs()
        .find(|(key, _)| key == "path")
        .map(|(_, value)| value.into_owned())
        .ok_or(OpenError::InvalidUri)?;
    normalize_path_input(&path)
}

/// Terminal step shared by all routes.
pub fn open_normalized<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
) -> Result<VaultInfo, OpenError> {
    windows::open_or_focus(app, root).map_err(|_| OpenError::WindowFailed)
}

/// Route a raw path string (picker/drag-drop/CLI) end to end.
pub fn open_path_input<R: Runtime>(
    app: &AppHandle<R>,
    input: &str,
) -> Result<VaultInfo, OpenError> {
    let root = normalize_path_input(input)?;
    open_normalized(app, &root)
}

/// Route `loam://` URIs (deep links) end to end.
pub fn open_uri_input<R: Runtime>(app: &AppHandle<R>, uri: &str) -> Result<VaultInfo, OpenError> {
    let root = parse_loam_uri(uri)?;
    open_normalized(app, &root)
}

/// The initial CLI path argument, if any: first non-flag argument.
pub fn cli_path_argument(args: impl Iterator<Item = String>) -> Option<String> {
    args.skip(1).find(|arg| !arg.starts_with('-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> (tempfile::TempDir, PathBuf) {
        let base = tempfile::tempdir().expect("temp base");
        let dir = base.path().join(name);
        std::fs::create_dir(&dir).expect("create vault dir");
        (base, dir)
    }

    /// AC1 + AC3: picker-style, drag-drop-style, CLI-style, and URI inputs all
    /// normalize to the same canonical path — including spaces and Unicode.
    #[test]
    fn all_routes_normalize_to_the_same_path() {
        for name in ["Notes Vault", "笔记 vault", "carnet café"] {
            let (_base, dir) = temp_vault(name);
            let canonical = dir.canonicalize().expect("canonicalize");
            let raw = dir.to_string_lossy();

            let picker = normalize_path_input(&raw).expect("picker path");
            let dropped = normalize_path_input(&format!("{raw}/")).expect("dropped path");
            let cli = normalize_path_input(&format!("  {raw}  ")).expect("cli path");
            let uri = {
                let encoded: String = tauri::Url::parse("loam://open")
                    .map(|mut url| {
                        url.query_pairs_mut().append_pair("path", &raw);
                        url.to_string()
                    })
                    .expect("build uri");
                parse_loam_uri(&encoded).expect("uri path")
            };

            assert_eq!(picker, canonical, "picker ({name})");
            assert_eq!(dropped, canonical, "trailing slash ({name})");
            assert_eq!(cli, canonical, "cli whitespace ({name})");
            assert_eq!(uri, canonical, "uri ({name})");
        }
    }

    /// macOS: an NFD-encoded input (as produced by some drag sources) resolves
    /// to the same vault as its NFC form via canonicalization.
    #[cfg(target_os = "macos")]
    #[test]
    fn unicode_normalization_forms_converge_on_macos() {
        let (_base, dir) = temp_vault("café-notes"); // NFC 'é'
        let canonical = dir.canonicalize().expect("canonicalize");
        let nfd = dir.to_string_lossy().replace('\u{e9}', "e\u{301}");
        let resolved = normalize_path_input(&nfd).expect("NFD input resolves");
        assert_eq!(
            windows::vault_key(&resolved),
            windows::vault_key(&canonical),
            "NFD and NFC inputs must key to the same vault"
        );
    }

    /// AC2: malformed URIs fail with stable error codes.
    #[test]
    fn malformed_uris_return_stable_errors() {
        let cases: &[(&str, OpenError)] = &[
            ("", OpenError::InvalidUri),
            ("not a uri", OpenError::InvalidUri),
            ("http://open?path=/tmp", OpenError::InvalidUri),
            ("loam://", OpenError::UnsupportedUriAction),
            ("loam://search?query=x", OpenError::UnsupportedUriAction),
            ("loam://open", OpenError::InvalidUri),
            ("loam://open?path=", OpenError::EmptyInput),
            ("loam://open?path=relative/notes", OpenError::RelativePath),
            (
                "loam://open?path=/definitely/missing",
                OpenError::NotAccessible,
            ),
            (
                "loam://open?path=%2Fdefinitely%2Fmissing",
                OpenError::NotAccessible,
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                &parse_loam_uri(input).unwrap_err(),
                expected,
                "input: {input}"
            );
        }
    }

    /// Traversal fragments never escape validation: they either resolve to a
    /// real directory (canonicalized, no `..` left) or fail.
    #[test]
    fn traversal_inputs_are_canonicalized_or_rejected() {
        let (_base, dir) = temp_vault("plain");
        let sneaky = format!("{}/../plain", dir.to_string_lossy());
        let resolved = normalize_path_input(&sneaky).expect("resolvable traversal");
        assert_eq!(resolved, dir.canonicalize().expect("canonical"));
        assert!(
            !resolved
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        );

        let missing = format!("{}/../nope", dir.to_string_lossy());
        assert_eq!(
            normalize_path_input(&missing).unwrap_err(),
            OpenError::NotAccessible
        );
    }

    #[test]
    fn cli_argument_skips_flags() {
        let args = |list: &[&str]| cli_path_argument(list.iter().map(|s| s.to_string()));
        assert_eq!(
            args(&["loam", "/vaults/notes"]),
            Some("/vaults/notes".into())
        );
        assert_eq!(
            args(&["loam", "--flag", "/vaults/notes"]),
            Some("/vaults/notes".into())
        );
        assert_eq!(args(&["loam", "--flag"]), None);
        assert_eq!(args(&["loam"]), None);
    }

    /// AC4: the shell's entry-route and shell modules perform no vault
    /// content reads — the only fs reads in this crate are the per-device
    /// geometry state in windows.rs (app-data, never a vault path).
    #[test]
    fn shell_sources_contain_no_vault_content_reads() {
        for module in ["routes.rs", "lib.rs", "menu.rs", "main.rs"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join(module);
            let source = std::fs::read_to_string(&path).expect("source readable");
            let code: String = source
                .lines()
                .filter(|line| {
                    let trimmed = line.trim_start();
                    !trimmed.starts_with("//") && !trimmed.starts_with("///")
                })
                .collect::<Vec<_>>()
                .join("\n");
            // Test module itself legitimately reads source files; strip it.
            let code = code.split("mod tests").next().expect("has prefix");
            for forbidden in ["read_to_string(", "fs::read(", "File::open("] {
                assert!(
                    !code.contains(forbidden),
                    "{module} must not contain {forbidden}"
                );
            }
        }
    }
}
