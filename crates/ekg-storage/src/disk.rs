use std::fs;
use std::path::{Path, PathBuf};

use ekg_contracts::DiskArtifactKind;

const MAX_DISCOVERY_DEPTH: usize = 12;
const MAX_SCANNED_ENTRIES: usize = 250_000;
const MAX_TRACKED_PATHS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskSnapshotEntry {
    pub relative_path: String,
    pub kind: DiskArtifactKind,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskSnapshot {
    pub entries: Vec<DiskSnapshotEntry>,
    pub tracked_bytes: u64,
    pub scanned_entries: usize,
    pub truncated: bool,
}

pub fn capture_project_disk(project_root: &Path) -> Result<DiskSnapshot, std::io::Error> {
    let root = fs::canonicalize(project_root)?;
    let mut state = ScanState::default();
    discover(&root, &root, 0, &mut state)?;
    state.entries.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.kind.cmp(&right.kind))
    });
    if state.entries.len() > MAX_TRACKED_PATHS {
        state.entries.sort_by(|left, right| {
            right
                .bytes
                .cmp(&left.bytes)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        state.entries.truncate(MAX_TRACKED_PATHS);
        state
            .entries
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        state.truncated = true;
    }
    let tracked_bytes = state.entries.iter().map(|entry| entry.bytes).sum();
    Ok(DiskSnapshot {
        entries: state.entries,
        tracked_bytes,
        scanned_entries: state.scanned_entries,
        truncated: state.truncated,
    })
}

#[derive(Default)]
struct ScanState {
    entries: Vec<DiskSnapshotEntry>,
    scanned_entries: usize,
    truncated: bool,
}

fn discover(
    root: &Path,
    directory: &Path,
    depth: usize,
    state: &mut ScanState,
) -> Result<(), std::io::Error> {
    if state.scanned_entries >= MAX_SCANNED_ENTRIES {
        state.truncated = true;
        return Ok(());
    }
    let mut children = match fs::read_dir(directory) {
        Ok(children) => children.flatten().collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            state.truncated = true;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        if state.scanned_entries >= MAX_SCANNED_ENTRIES {
            state.truncated = true;
            break;
        }
        state.scanned_entries += 1;
        let path = child.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                state.truncated = true;
                continue;
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let name = child.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        if let Some(kind) = classify(&name) {
            let bytes = measure_tree(&path, state)?;
            state.entries.push(DiskSnapshotEntry {
                relative_path: relative_path(root, &path),
                kind,
                bytes,
            });
            continue;
        }
        if depth < MAX_DISCOVERY_DEPTH {
            discover(root, &path, depth + 1, state)?;
        } else {
            state.truncated = true;
        }
    }
    Ok(())
}

fn measure_tree(directory: &Path, state: &mut ScanState) -> Result<u64, std::io::Error> {
    let mut bytes = 0_u64;
    let mut stack = vec![PathBuf::from(directory)];
    while let Some(current) = stack.pop() {
        let children = match fs::read_dir(&current) {
            Ok(children) => children,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                state.truncated = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        for child in children.flatten() {
            if state.scanned_entries >= MAX_SCANNED_ENTRIES {
                state.truncated = true;
                return Ok(bytes);
            }
            state.scanned_entries += 1;
            let metadata = match fs::symlink_metadata(child.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    state.truncated = true;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(child.path());
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(bytes)
}

fn classify(name: &str) -> Option<DiskArtifactKind> {
    match name {
        "build" | "DerivedData" | "target" | ".build" | ".gradle" | "Pods" => {
            Some(DiskArtifactKind::BuildCache)
        }
        "node_modules" | ".venv" | "venv" => Some(DiskArtifactKind::DependencyCache),
        "dist" | "coverage" | ".next" => Some(DiskArtifactKind::GeneratedOutput),
        "tmp" | ".tmp" => Some(DiskArtifactKind::TemporaryOutput),
        _ => None,
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
