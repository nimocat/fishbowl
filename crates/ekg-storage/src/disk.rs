use std::collections::BTreeMap;
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use ekg_contracts::DiskArtifactKind;
use serde::{Deserialize, Serialize};

const MAX_DISCOVERY_DEPTH: usize = 12;
const MAX_SCANNED_ENTRIES: usize = 250_000;
const MAX_TRACKED_PATHS: usize = 256;
const MAX_CACHE_STAMPS: usize = 250_000;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskDirectoryStamp {
    pub relative_path: String,
    pub modified_nanos: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskMeasurementCacheEntry {
    pub relative_path: String,
    pub kind: DiskArtifactKind,
    pub bytes: u64,
    pub truncated: bool,
    pub directory_stamps: Vec<DiskDirectoryStamp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskCapture {
    pub snapshot: DiskSnapshot,
    pub cache_entries: Vec<DiskMeasurementCacheEntry>,
    pub cache_hits: usize,
    pub cache_misses: usize,
    pub discovery_complete: bool,
}

impl DiskCapture {
    pub fn uncached(snapshot: DiskSnapshot) -> Self {
        Self {
            snapshot,
            cache_entries: Vec::new(),
            cache_hits: 0,
            cache_misses: 0,
            discovery_complete: false,
        }
    }
}

pub fn capture_project_disk(project_root: &Path) -> Result<DiskSnapshot, std::io::Error> {
    Ok(capture_project_disk_cached(project_root, &[])?.snapshot)
}

pub fn capture_project_disk_cached(
    project_root: &Path,
    cached: &[DiskMeasurementCacheEntry],
) -> Result<DiskCapture, std::io::Error> {
    let root = fs::canonicalize(project_root)?;
    let mut state = ScanState::default();
    let mut candidates = Vec::new();
    discover(&root, &root, 0, &mut state, &mut candidates)?;
    candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    candidates.dedup_by(|left, right| left.relative_path == right.relative_path);
    if candidates.len() > MAX_TRACKED_PATHS {
        candidates.truncate(MAX_TRACKED_PATHS);
        state.truncated = true;
        state.discovery_complete = false;
    }

    let cache = cached
        .iter()
        .filter(|entry| valid_relative_path(&entry.relative_path))
        .map(|entry| (entry.relative_path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut entries = Vec::with_capacity(candidates.len());
    let mut cache_entries = Vec::with_capacity(candidates.len());
    let mut cache_hits = 0;
    let mut cache_misses = 0;
    for candidate in candidates {
        let cached = cache.get(candidate.relative_path.as_str()).copied();
        let measured = if let Some(cached) = cached.filter(|entry| entry.kind == candidate.kind) {
            if cache_valid(&candidate.path, cached, &mut state) {
                cache_hits += 1;
                // Directory mtimes reliably catch entry creation, removal, and atomic replacement,
                // but an in-place file rewrite may leave every parent directory unchanged. Cached
                // measurements therefore remain useful for attribution while staying review-only.
                state.truncated = true;
                cached.clone()
            } else {
                cache_misses += 1;
                measure_candidate(&candidate, &mut state)?
            }
        } else {
            cache_misses += 1;
            measure_candidate(&candidate, &mut state)?
        };
        state.truncated |= measured.truncated;
        entries.push(DiskSnapshotEntry {
            relative_path: measured.relative_path.clone(),
            kind: measured.kind,
            bytes: measured.bytes,
        });
        if !measured.directory_stamps.is_empty() {
            cache_entries.push(measured);
        }
    }
    let tracked_bytes = entries
        .iter()
        .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
    Ok(DiskCapture {
        snapshot: DiskSnapshot {
            entries,
            tracked_bytes,
            scanned_entries: state.scanned_entries,
            truncated: state.truncated,
        },
        cache_entries,
        cache_hits,
        cache_misses,
        discovery_complete: state.discovery_complete,
    })
}

#[derive(Default)]
struct ScanState {
    scanned_entries: usize,
    truncated: bool,
    discovery_complete: bool,
}

struct Candidate {
    path: PathBuf,
    relative_path: String,
    kind: DiskArtifactKind,
}

fn discover(
    root: &Path,
    directory: &Path,
    depth: usize,
    state: &mut ScanState,
    candidates: &mut Vec<Candidate>,
) -> Result<(), std::io::Error> {
    if depth == 0 {
        state.discovery_complete = true;
    }
    if !take_budget(state) {
        state.discovery_complete = false;
        return Ok(());
    }
    let mut children = match fs::read_dir(directory) {
        Ok(children) => children.flatten().collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            state.truncated = true;
            state.discovery_complete = false;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        if !take_budget(state) {
            state.discovery_complete = false;
            break;
        }
        let path = child.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                state.truncated = true;
                state.discovery_complete = false;
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
            candidates.push(Candidate {
                relative_path: relative_path(root, &path),
                path,
                kind,
            });
            continue;
        }
        if depth < MAX_DISCOVERY_DEPTH {
            discover(root, &path, depth + 1, state, candidates)?;
        } else {
            state.truncated = true;
            state.discovery_complete = false;
        }
    }
    Ok(())
}

fn cache_valid(
    candidate: &Path,
    cached: &DiskMeasurementCacheEntry,
    state: &mut ScanState,
) -> bool {
    if cached.directory_stamps.is_empty() || cached.directory_stamps.len() > MAX_CACHE_STAMPS {
        return false;
    }
    for stamp in &cached.directory_stamps {
        if stamp.modified_nanos == 0 || !valid_relative_path_or_dot(&stamp.relative_path) {
            return false;
        }
        if !take_budget(state) {
            // Preserve the prior bounded estimate when validation itself reaches the global
            // metadata budget. `truncated` is already set, so this cannot authorize cleanup.
            return true;
        }
        let path = if stamp.relative_path == "." {
            candidate.to_path_buf()
        } else {
            candidate.join(&stamp.relative_path)
        };
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return false;
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || modified_nanos(&metadata) != stamp.modified_nanos
        {
            return false;
        }
    }
    true
}

fn measure_candidate(
    candidate: &Candidate,
    state: &mut ScanState,
) -> Result<DiskMeasurementCacheEntry, std::io::Error> {
    let metadata = fs::symlink_metadata(&candidate.path)?;
    let mut bytes = 0_u64;
    let mut truncated = false;
    let mut directory_stamps = Vec::new();
    let mut stack = vec![(candidate.path.clone(), metadata)];
    while let Some((current, metadata)) = stack.pop() {
        if directory_stamps.len() >= MAX_CACHE_STAMPS || !take_budget(state) {
            truncated = true;
            break;
        }
        directory_stamps.push(DiskDirectoryStamp {
            relative_path: relative_path(&candidate.path, &current),
            modified_nanos: modified_nanos(&metadata),
        });
        let mut children = match fs::read_dir(&current) {
            Ok(children) => children.flatten().collect::<Vec<_>>(),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                truncated = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        children.sort_by_key(|entry| entry.file_name());
        for child in children.into_iter().rev() {
            if !take_budget(state) {
                truncated = true;
                break;
            }
            let metadata = match fs::symlink_metadata(child.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    truncated = true;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push((child.path(), metadata));
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
        if truncated && state.scanned_entries >= MAX_SCANNED_ENTRIES {
            break;
        }
    }
    Ok(DiskMeasurementCacheEntry {
        relative_path: candidate.relative_path.clone(),
        kind: candidate.kind,
        bytes,
        truncated,
        directory_stamps,
    })
}

fn take_budget(state: &mut ScanState) -> bool {
    if state.scanned_entries >= MAX_SCANNED_ENTRIES {
        state.truncated = true;
        false
    } else {
        state.scanned_entries += 1;
        true
    }
}

fn modified_nanos(metadata: &Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn valid_relative_path(path: &str) -> bool {
    path != "." && valid_relative_path_or_dot(path)
}

fn valid_relative_path_or_dot(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4_096
        && !Path::new(path).is_absolute()
        && !Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
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
    let value = path
        .strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if value.is_empty() { ".".into() } else { value }
}
