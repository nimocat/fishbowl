//! Backup-first SQLite schema ownership and recovery.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use rusqlite::{Connection, OpenFlags};

pub const SCHEMA_VERSION: i64 = 7;
pub const EKG_APPLICATION_ID: i64 = 0x454b4701;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseFaultPoint {
    AfterBackup,
    BeforeCommit,
}

#[derive(Debug)]
pub enum DatabaseError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    CorruptRecovery,
    NewerSchema { found: i64, supported: i64 },
    Injected(DatabaseFaultPoint),
}

impl From<std::io::Error> for DatabaseError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<rusqlite::Error> for DatabaseError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

pub struct ManagedDatabase {
    connection: Connection,
    backup_path: Option<PathBuf>,
}

impl ManagedDatabase {
    pub fn connection(&self) -> &Connection {
        &self.connection
    }
    pub fn backup_path(&self) -> Option<&Path> {
        self.backup_path.as_deref()
    }
    pub fn user_version(&self) -> Result<i64, DatabaseError> {
        Ok(self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }
    pub fn application_id(&self) -> Result<i64, DatabaseError> {
        Ok(self
            .connection
            .pragma_query_value(None, "application_id", |row| row.get(0))?)
    }
    pub fn quick_check(&self) -> Result<Vec<String>, DatabaseError> {
        quick_check(&self.connection)
    }
    pub fn has_table(&self, table: &str) -> Result<bool, DatabaseError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?)",
            [table],
            |row| row.get::<_, i64>(0),
        )? != 0)
    }
}

pub struct DatabaseManager;

impl DatabaseManager {
    pub fn open(path: &Path) -> Result<ManagedDatabase, DatabaseError> {
        Self::open_with_fault(path, None)
    }

    pub fn open_with_fault(
        path: &Path,
        fault: Option<DatabaseFaultPoint>,
    ) -> Result<ManagedDatabase, DatabaseError> {
        let existed = path.exists();
        if existed {
            inspect_existing(path)?;
        }
        if let Some(parent) = path.parent() {
            let create_parent = !parent.exists();
            std::fs::create_dir_all(parent)?;
            if create_parent {
                secure_directory(parent)?;
            }
        }
        let current_version = if existed { readonly_version(path)? } else { 0 };
        let backup_path = if existed && current_version < SCHEMA_VERSION {
            let backup = backup_path(path);
            backup_database(path, &backup)?;
            if fault == Some(DatabaseFaultPoint::AfterBackup) {
                return Err(DatabaseError::Injected(DatabaseFaultPoint::AfterBackup));
            }
            Some(backup)
        } else {
            None
        };
        let mut connection = Connection::open(path)?;
        configure(&connection, path)?;
        migrate(&mut connection, current_version, fault)?;
        if !existed {
            connection.pragma_update(None, "application_id", EKG_APPLICATION_ID)?;
        }
        secure_file(path)?;
        Ok(ManagedDatabase {
            connection,
            backup_path,
        })
    }

    pub fn restore_backup(backup: &Path, destination: &Path) -> Result<(), DatabaseError> {
        inspect_existing(backup)?;
        if destination.exists() {
            return Err(DatabaseError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "destination exists",
            )));
        }
        backup_database(backup, destination)?;
        inspect_existing(destination)?;
        secure_file(destination)?;
        Ok(())
    }
}

fn inspect_existing(path: &Path) -> Result<(), DatabaseError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| DatabaseError::CorruptRecovery)?;
    let checks = quick_check(&connection).map_err(|_| DatabaseError::CorruptRecovery)?;
    if checks.iter().any(|value| value != "ok") {
        return Err(DatabaseError::CorruptRecovery);
    }
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| DatabaseError::CorruptRecovery)?;
    if version > SCHEMA_VERSION {
        return Err(DatabaseError::NewerSchema {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(())
}

fn readonly_version(path: &Path) -> Result<i64, DatabaseError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn configure(connection: &Connection, path: &Path) -> Result<(), DatabaseError> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    secure_file(path)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.exists() {
            secure_file(&sidecar)?;
        }
    }
    Ok(())
}

fn migrate(
    connection: &mut Connection,
    current: i64,
    fault: Option<DatabaseFaultPoint>,
) -> Result<(), DatabaseError> {
    if current == SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    if (2..=3).contains(&current) {
        transaction.execute_batch(MIGRATION_V4)?;
    }
    transaction.execute_batch(FINAL_SCHEMA)?;
    if (1..=5).contains(&current) {
        transaction.execute_batch(MIGRATION_V6)?;
    }
    transaction.execute_batch(FINAL_INDEXES_AND_TRIGGERS)?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    if fault == Some(DatabaseFaultPoint::BeforeCommit) {
        return Err(DatabaseError::Injected(DatabaseFaultPoint::BeforeCommit));
    }
    transaction.commit()?;
    Ok(())
}

fn backup_database(source: &Path, destination: &Path) -> Result<(), DatabaseError> {
    let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut destination_connection = Connection::open(destination)?;
    let backup = rusqlite::backup::Backup::new(&source, &mut destination_connection)?;
    backup.run_to_completion(128, Duration::from_millis(10), None)?;
    drop(backup);
    secure_file(destination)?;
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.pre-rust-v7-{}.bak",
        path.display(),
        Utc::now().timestamp_millis()
    ))
}
fn quick_check(connection: &Connection) -> Result<Vec<String>, DatabaseError> {
    let mut statement = connection.prepare("PRAGMA quick_check")?;
    Ok(statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), DatabaseError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}
#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), DatabaseError> {
    Ok(())
}
#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), DatabaseError> {
    use std::os::unix::fs::PermissionsExt;
    if path.exists() {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), DatabaseError> {
    Ok(())
}

const FINAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(trim(name))>0),description TEXT,canonical_root TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS project_aliases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,root TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,title TEXT NOT NULL CHECK(length(trim(title))>0),status TEXT NOT NULL CHECK(status IN('open','candidate','verified','regressed','retired')),created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,type TEXT NOT NULL CHECK(type IN('Problem','Attempt','RootCause','Solution','Verification','SuccessCase','Guardrail','Artifact')),status TEXT NOT NULL CHECK(status IN('open','candidate','verified','regressed','retired')),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,source_id TEXT NOT NULL REFERENCES nodes(id),relation TEXT NOT NULL,target_id TEXT NOT NULL REFERENCES nodes(id),created_at TEXT NOT NULL,UNIQUE(case_id,source_id,relation,target_id),CHECK(source_id<>target_id)) STRICT;
CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),node_id TEXT NOT NULL REFERENCES nodes(id),kind TEXT NOT NULL CHECK(kind IN('automated','human')),command TEXT,exit_status INTEGER,data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS fingerprints(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),problem_node_id TEXT NOT NULL REFERENCES nodes(id),algorithm TEXT NOT NULL,value TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,algorithm,value)) STRICT;
CREATE TABLE IF NOT EXISTS guardrails(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id),enforcement TEXT NOT NULL CHECK(enforcement IN('advise','warn','block')),criteria TEXT NOT NULL CHECK(json_valid(criteria)),created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL REFERENCES projects(id),type TEXT NOT NULL CHECK(length(trim(type))>0),aggregate_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),occurred_at TEXT NOT NULL,case_id TEXT REFERENCES cases(id)) STRICT;
CREATE TABLE IF NOT EXISTS command_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),case_id TEXT REFERENCES cases(id),attempt_node_id TEXT REFERENCES nodes(id),command TEXT NOT NULL CHECK(json_valid(command)),working_directory TEXT NOT NULL,exit_status INTEGER,signal TEXT,duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),excerpt TEXT NOT NULL,raw_log_path TEXT,raw_log_digest TEXT,started_at TEXT NOT NULL,finished_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),node_id TEXT UNIQUE REFERENCES nodes(id),kind TEXT NOT NULL CHECK(length(trim(kind))>0),uri TEXT NOT NULL CHECK(length(trim(uri))>0),digest TEXT,is_external INTEGER NOT NULL DEFAULT 0 CHECK(is_external IN(0,1)),metadata TEXT NOT NULL CHECK(json_valid(metadata)),created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS import_previews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','applied','stale')),created_at TEXT NOT NULL,applied_at TEXT,parser_version TEXT NOT NULL DEFAULT 'legacy',source_manifest TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_manifest)),expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',UNIQUE(project_id,id)) STRICT;
CREATE TABLE IF NOT EXISTS import_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),preview_id TEXT NOT NULL,source_key TEXT NOT NULL,node_type TEXT NOT NULL CHECK(node_type IN('Problem','Attempt','RootCause','Solution','Verification','SuccessCase','Guardrail','Artifact')),payload TEXT NOT NULL CHECK(json_valid(payload)),selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN(0,1)),created_at TEXT NOT NULL,UNIQUE(project_id,preview_id,source_key),FOREIGN KEY(project_id,preview_id) REFERENCES import_previews(project_id,id) ON DELETE CASCADE) STRICT;
CREATE TABLE IF NOT EXISTS source_keys(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_kind TEXT NOT NULL,source_key TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES nodes(id),created_at TEXT NOT NULL,UNIQUE(project_id,source_kind,source_key)) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS node_search USING fts5(project_id UNINDEXED,node_id UNINDEXED,title,body,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS operation_results(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),operation_id TEXT NOT NULL,kind TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),created_at TEXT NOT NULL,UNIQUE(project_id,operation_id)) STRICT;
CREATE TABLE IF NOT EXISTS relevance_feedback(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),case_id TEXT NOT NULL REFERENCES cases(id),context_digest TEXT NOT NULL CHECK(length(context_digest)=64),useful INTEGER NOT NULL CHECK(useful IN(0,1)),created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS case_merge_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_case_id TEXT NOT NULL REFERENCES cases(id),target_case_id TEXT NOT NULL REFERENCES cases(id),score REAL NOT NULL CHECK(score>=0 AND score<=1),reasons TEXT NOT NULL CHECK(json_valid(reasons)),status TEXT NOT NULL CHECK(status IN('proposed','applied','rejected')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,source_case_id,target_case_id),CHECK(source_case_id<>target_case_id)) STRICT;
CREATE TABLE IF NOT EXISTS case_supersessions(project_id TEXT NOT NULL REFERENCES projects(id),source_case_id TEXT PRIMARY KEY REFERENCES cases(id),target_case_id TEXT NOT NULL REFERENCES cases(id),proposal_id TEXT NOT NULL REFERENCES case_merge_proposals(id),created_at TEXT NOT NULL,CHECK(source_case_id<>target_case_id)) STRICT;
"#;

const MIGRATION_V6: &str = r#"
DROP TRIGGER IF EXISTS events_reject_update;
ALTER TABLE events ADD COLUMN case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT;
UPDATE events SET case_id=CASE WHEN EXISTS(SELECT 1 FROM cases WHERE cases.id=events.aggregate_id AND cases.project_id=events.project_id) THEN aggregate_id ELSE json_extract(payload,'$.caseId') END WHERE case_id IS NULL AND (EXISTS(SELECT 1 FROM cases WHERE cases.id=events.aggregate_id AND cases.project_id=events.project_id) OR EXISTS(SELECT 1 FROM cases WHERE cases.id=json_extract(events.payload,'$.caseId') AND cases.project_id=events.project_id));
"#;

const MIGRATION_V4: &str = r#"
ALTER TABLE import_previews ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE import_previews ADD COLUMN source_manifest TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_manifest));
ALTER TABLE import_previews ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
"#;

const FINAL_INDEXES_AND_TRIGGERS: &str = r#"
CREATE INDEX IF NOT EXISTS cases_project_id_idx ON cases(project_id);
CREATE INDEX IF NOT EXISTS nodes_case_id_idx ON nodes(case_id);
CREATE INDEX IF NOT EXISTS edges_case_id_idx ON edges(case_id);
CREATE INDEX IF NOT EXISTS edges_case_source_idx ON edges(case_id,source_id);
CREATE INDEX IF NOT EXISTS edges_case_target_idx ON edges(case_id,target_id);
CREATE INDEX IF NOT EXISTS evidence_project_node_idx ON evidence(project_id,node_id);
CREATE INDEX IF NOT EXISTS guardrails_project_id_idx ON guardrails(project_id);
CREATE INDEX IF NOT EXISTS events_project_sequence_idx ON events(project_id,sequence);
CREATE INDEX IF NOT EXISTS events_project_case_sequence_idx ON events(project_id,case_id,sequence);
CREATE INDEX IF NOT EXISTS command_runs_project_started_idx ON command_runs(project_id,started_at);
CREATE INDEX IF NOT EXISTS artifacts_project_id_idx ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS import_previews_project_created_idx ON import_previews(project_id,created_at);
CREATE INDEX IF NOT EXISTS import_proposals_project_preview_idx ON import_proposals(project_id,preview_id);
CREATE INDEX IF NOT EXISTS source_keys_project_node_idx ON source_keys(project_id,node_id);
CREATE INDEX IF NOT EXISTS operation_results_project_id_idx ON operation_results(project_id,operation_id);
CREATE INDEX IF NOT EXISTS relevance_feedback_project_case_idx ON relevance_feedback(project_id,case_id,created_at);
CREATE TRIGGER IF NOT EXISTS events_reject_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_reject_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_case_ownership_insert BEFORE INSERT ON events WHEN NEW.case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'event case project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS evidence_project_ownership_insert BEFORE INSERT ON evidence WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'evidence project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS evidence_project_ownership_update BEFORE UPDATE OF project_id,node_id ON evidence WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'evidence project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS fingerprints_project_ownership_insert BEFORE INSERT ON fingerprints WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.problem_node_id AND nodes.type='Problem' AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'fingerprint project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS fingerprints_project_ownership_update BEFORE UPDATE OF project_id,problem_node_id ON fingerprints WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.problem_node_id AND nodes.type='Problem' AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'fingerprint project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS guardrails_project_ownership_insert BEFORE INSERT ON guardrails WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND nodes.type='Guardrail' AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'guardrail project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS guardrails_project_ownership_update BEFORE UPDATE OF project_id,node_id ON guardrails WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND nodes.type='Guardrail' AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'guardrail project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_project_ownership_insert BEFORE INSERT ON artifacts WHEN NEW.node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND nodes.type='Artifact' AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'artifact project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_project_ownership_update BEFORE UPDATE OF project_id,node_id ON artifacts WHEN NEW.node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND nodes.type='Artifact' AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'artifact project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS command_runs_project_ownership_insert BEFORE INSERT ON command_runs WHEN (NEW.case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND project_id=NEW.project_id)) OR (NEW.attempt_node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.attempt_node_id AND nodes.type='Attempt' AND cases.project_id=NEW.project_id AND (NEW.case_id IS NULL OR nodes.case_id=NEW.case_id))) BEGIN SELECT RAISE(ABORT,'command run project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS command_runs_project_ownership_update BEFORE UPDATE OF project_id,case_id,attempt_node_id ON command_runs WHEN (NEW.case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND project_id=NEW.project_id)) OR (NEW.attempt_node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.attempt_node_id AND nodes.type='Attempt' AND cases.project_id=NEW.project_id AND (NEW.case_id IS NULL OR nodes.case_id=NEW.case_id))) BEGIN SELECT RAISE(ABORT,'command run project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS source_keys_project_ownership_insert BEFORE INSERT ON source_keys WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'source key project ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS source_keys_project_ownership_update BEFORE UPDATE OF project_id,node_id ON source_keys WHEN NOT EXISTS(SELECT 1 FROM nodes JOIN cases ON cases.id=nodes.case_id WHERE nodes.id=NEW.node_id AND cases.project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'source key project ownership mismatch'); END;
"#;
