use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ekg_contracts::{
    ApplyImportContentInput, ApplyImportInput, ErrorCode, ImportContentSource, ImportSourceRequest,
    PreviewImportContentInput, PreviewImportInput, ProjectReference,
};
use ekg_storage::{ReadRepository, StorageError};

use crate::protocol::ProtocolError;

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_SOURCES: usize = 32;
const GIT_HINT_PREFIX: &str = "git-range:";

pub fn acquire_preview(
    repository: &ReadRepository,
    input: &PreviewImportInput,
) -> Result<PreviewImportContentInput, ProtocolError> {
    if input.sources.is_empty() || input.sources.len() > MAX_SOURCES {
        return Err(invalid());
    }
    let roots = project_roots(repository, &input.project)?;
    let primary = roots.first().ok_or_else(not_found)?;
    let mut sources = Vec::with_capacity(input.sources.len());
    let mut total = 0usize;
    for source in &input.sources {
        let acquired = match source {
            ImportSourceRequest::File { path } => acquire_file(Path::new(path), &roots)?,
            ImportSourceRequest::Git { range } => acquire_git(primary, range)?,
        };
        total = total
            .checked_add(acquired.content.len())
            .ok_or_else(too_large)?;
        if total > MAX_SOURCE_BYTES {
            return Err(too_large());
        }
        sources.push(acquired);
    }
    Ok(PreviewImportContentInput {
        project: input.project.clone(),
        sources,
    })
}

pub fn acquire_apply(
    repository: &ReadRepository,
    input: &ApplyImportInput,
) -> Result<ApplyImportContentInput, ProtocolError> {
    let roots = project_roots(repository, &input.project)?;
    let primary = roots.first().ok_or_else(not_found)?;
    let hints = repository
        .import_preview_path_hints(&input.project, &input.preview_id)
        .map_err(map_storage)?;
    if hints.is_empty() || hints.len() > MAX_SOURCES {
        return Err(invalid());
    }
    let mut sources = Vec::with_capacity(hints.len());
    let mut total = 0usize;
    for hint in hints {
        let acquired = if let Some(range) = hint.strip_prefix(GIT_HINT_PREFIX) {
            acquire_git(primary, range)?
        } else {
            acquire_file(Path::new(&hint), &roots)?
        };
        total = total
            .checked_add(acquired.content.len())
            .ok_or_else(too_large)?;
        if total > MAX_SOURCE_BYTES {
            return Err(too_large());
        }
        sources.push(acquired);
    }
    Ok(ApplyImportContentInput {
        project: input.project.clone(),
        preview_id: input.preview_id.clone(),
        proposal_ids: input.proposal_ids.clone(),
        operation_id: input.operation_id.clone(),
        sources,
    })
}

fn project_roots(
    repository: &ReadRepository,
    project: &ProjectReference,
) -> Result<Vec<PathBuf>, ProtocolError> {
    let selected = repository
        .resolve_project_record(project)
        .map_err(map_storage)?;
    let all = repository.list_projects().map_err(map_storage)?;
    let project = all
        .into_iter()
        .find(|candidate| candidate.project.id == selected.id)
        .ok_or_else(not_found)?;
    std::iter::once(project.project.root)
        .chain(project.aliases.into_iter().map(|alias| alias.root))
        .map(|root| PathBuf::from(root).canonicalize().map_err(|_| not_found()))
        .collect()
}

fn acquire_file(path: &Path, roots: &[PathBuf]) -> Result<ImportContentSource, ProtocolError> {
    let canonical = path.canonicalize().map_err(|_| source_failed())?;
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(ProtocolError::new(
            ErrorCode::PathOutsideProject,
            "Import source must be inside the selected project",
        ));
    }
    let metadata = canonical.metadata().map_err(|_| source_failed())?;
    if !metadata.is_file() {
        return Err(invalid());
    }
    if metadata.len() > MAX_SOURCE_BYTES as u64 {
        return Err(too_large());
    }
    let mut file = File::open(&canonical).map_err(|_| source_failed())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take((MAX_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| source_failed())?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(too_large());
    }
    let content = String::from_utf8(bytes).map_err(|_| invalid())?;
    Ok(ImportContentSource {
        path_hint: canonical.to_string_lossy().into_owned(),
        content,
    })
}

fn acquire_git(root: &Path, range: &str) -> Result<ImportContentSource, ProtocolError> {
    let (base, head) = explicit_range(range)?;
    let base = resolve_commit(root, base)?;
    let head = resolve_commit(root, head)?;
    let immutable_range = format!("{base}..{head}");
    let commits = run_git_bounded(
        root,
        &["rev-list", "--reverse", immutable_range.as_str()],
        MAX_SOURCE_BYTES,
    )?;
    let commits = commits
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if commits.is_empty() || commits.iter().any(|value| !is_commit(value)) {
        return Err(invalid());
    }
    let mut content = String::new();
    for commit in commits {
        let remaining = MAX_SOURCE_BYTES.saturating_sub(content.len());
        let shown = run_git_bounded(
            root,
            &[
                "show",
                "--no-ext-diff",
                "--no-renames",
                "--format=fuller",
                commit.as_str(),
            ],
            remaining,
        )?;
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(&shown);
        if content.len() > MAX_SOURCE_BYTES {
            return Err(too_large());
        }
    }
    Ok(ImportContentSource {
        path_hint: format!("{GIT_HINT_PREFIX}{immutable_range}"),
        content,
    })
}

fn explicit_range(range: &str) -> Result<(&str, &str), ProtocolError> {
    if range.contains("...") || range.matches("..").count() != 1 {
        return Err(invalid());
    }
    let (base, head) = range.split_once("..").ok_or_else(invalid)?;
    if !safe_revision(base) || !safe_revision(head) {
        return Err(invalid());
    }
    Ok((base, head))
}

fn safe_revision(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'.' | b'-' | b'~' | b'^')
        })
}

fn resolve_commit(root: &Path, revision: &str) -> Result<String, ProtocolError> {
    let expression = format!("{revision}^{{commit}}");
    let commit = run_git_bounded(root, &["rev-parse", "--verify", &expression], 128)?;
    let commit = commit.trim().to_owned();
    if !is_commit(&commit) {
        return Err(source_failed());
    }
    Ok(commit)
}

fn is_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn run_git_bounded(root: &Path, arguments: &[&str], limit: usize) -> Result<String, ProtocolError> {
    let mut child = Command::new("git")
        .args(arguments)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| source_failed())?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(source_failed)?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| source_failed())?;
    let status = child.wait().map_err(|_| source_failed())?;
    if !status.success() {
        return Err(source_failed());
    }
    if bytes.len() > limit {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

fn map_storage(error: StorageError) -> ProtocolError {
    match error {
        StorageError::Contract(code) => ProtocolError::new(code, "Request argument is invalid"),
        StorageError::ProjectNotFound => not_found(),
        StorageError::Sqlite(_) | StorageError::InvalidStoredData(_) => {
            ProtocolError::new(ErrorCode::InternalError, "Unexpected service failure")
        }
    }
}

fn invalid() -> ProtocolError {
    ProtocolError::new(ErrorCode::InvalidArgument, "Import source is invalid")
}

fn too_large() -> ProtocolError {
    ProtocolError::new(
        ErrorCode::PayloadTooLarge,
        "Import source exceeds the bounded limit",
    )
}

fn source_failed() -> ProtocolError {
    ProtocolError::new(ErrorCode::NotFound, "Import source could not be read")
}

fn not_found() -> ProtocolError {
    ProtocolError::new(
        ErrorCode::NotFound,
        "Project or import preview was not found",
    )
}
