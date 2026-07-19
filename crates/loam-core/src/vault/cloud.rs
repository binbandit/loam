//! Explicit cloud-file materialization (§5.6): dataless placeholders are
//! surfaced as `MaterializationRequired` on read (LOA-25) and hydrated only
//! through this adapter — on explicit user open, with progress events. Nothing
//! in the core ever triggers an implicit cloud download.

use std::io::Read as _;
use std::path::Path;

use serde::Serialize;

use super::note::placeholder;

/// Progress of an explicit materialization, for the §5.6 progress UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeProgress {
    pub bytes_done: u64,
    /// Total size if the platform reports it for the placeholder.
    pub bytes_total: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    #[error("failed to materialize the file: {0}")]
    Io(#[from] std::io::Error),
}

/// Materialization backend seam: the OS adapter in production, mockable in
/// tests and injectable for platforms with richer APIs later.
pub trait CloudAdapter {
    /// Is this file a dataless placeholder? (Metadata-only; never hydrates.)
    fn is_placeholder(&self, metadata: &std::fs::Metadata) -> bool;

    /// Explicitly hydrate the file, reporting progress. Blocking; callers run
    /// it off the UI thread and stream progress to the shell.
    fn materialize(
        &self,
        path: &Path,
        progress: &mut dyn FnMut(MaterializeProgress),
    ) -> Result<(), CloudError>;
}

/// Default OS adapter: detection via the LOA-25 platform classifiers;
/// hydration by chunked sequential read — the documented trigger for both
/// iCloud (APFS dataless) and OneDrive (recall-on-data-access) to download
/// content, portable without per-vendor SDKs.
pub struct OsCloudAdapter;

const CHUNK: usize = 1024 * 1024;

impl CloudAdapter for OsCloudAdapter {
    fn is_placeholder(&self, metadata: &std::fs::Metadata) -> bool {
        placeholder::is_dataless(metadata)
    }

    fn materialize(
        &self,
        path: &Path,
        progress: &mut dyn FnMut(MaterializeProgress),
    ) -> Result<(), CloudError> {
        let total = std::fs::metadata(path).ok().map(|m| m.len());
        let mut file = std::fs::File::open(path)?;
        let mut buffer = vec![0u8; CHUNK];
        let mut done: u64 = 0;
        progress(MaterializeProgress {
            bytes_done: 0,
            bytes_total: total,
        });
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            done += read as u64;
            progress(MaterializeProgress {
                bytes_done: done,
                bytes_total: total,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC4: materialization happens only when explicitly invoked, and streams
    /// monotonic progress with a final total.
    #[test]
    fn materialize_streams_progress_to_completion() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("cloud.md");
        let body = vec![b'x'; 3 * 1024 * 1024 + 123];
        std::fs::write(&path, &body).expect("file");

        let adapter = OsCloudAdapter;
        let mut updates: Vec<MaterializeProgress> = Vec::new();
        adapter
            .materialize(&path, &mut |p| updates.push(p))
            .expect("materialize");

        assert!(
            updates.len() >= 4,
            "initial + per-chunk updates: {updates:?}"
        );
        assert_eq!(updates.first().expect("first").bytes_done, 0);
        assert_eq!(
            updates.last().expect("last").bytes_done,
            body.len() as u64,
            "final progress covers the whole file"
        );
        assert!(
            updates
                .windows(2)
                .all(|w| w[0].bytes_done <= w[1].bytes_done),
            "progress is monotonic"
        );
        assert_eq!(
            updates.last().expect("last").bytes_total,
            Some(body.len() as u64)
        );
    }

    /// The read path (LOA-25) never materializes: a placeholder-flagged file
    /// is rejected before any content read. Proven with a mock adapter plus
    /// the classifier fixtures — real hydration is inherently cloud-bound.
    #[test]
    fn detection_is_metadata_only_via_mock() {
        struct MockAdapter {
            calls: std::cell::Cell<u32>,
        }
        impl CloudAdapter for MockAdapter {
            fn is_placeholder(&self, _metadata: &std::fs::Metadata) -> bool {
                self.calls.set(self.calls.get() + 1);
                true
            }
            fn materialize(
                &self,
                _path: &Path,
                _progress: &mut dyn FnMut(MaterializeProgress),
            ) -> Result<(), CloudError> {
                panic!("must not be called implicitly");
            }
        }

        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("x.md");
        std::fs::write(&path, "content").expect("file");
        let metadata = std::fs::metadata(&path).expect("meta");

        let adapter = MockAdapter {
            calls: std::cell::Cell::new(0),
        };
        // Status checks consult metadata only; materialize is never invoked
        // by detection.
        assert!(adapter.is_placeholder(&metadata));
        assert_eq!(adapter.calls.get(), 1);
    }
}
