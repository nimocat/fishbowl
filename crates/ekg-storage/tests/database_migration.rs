use std::fs;

use ekg_storage::{DatabaseFaultPoint, DatabaseManager};
use rusqlite::Connection;

#[test]
fn new_database_is_schema_v8_safe_and_integral() {
    let path = path("new");
    let managed = DatabaseManager::open(&path).unwrap();
    assert_eq!(managed.user_version().unwrap(), 8);
    assert_eq!(managed.quick_check().unwrap(), vec!["ok"]);
    assert_eq!(managed.application_id().unwrap(), 0x454b4701);
    for table in [
        "projects",
        "import_previews",
        "relevance_feedback",
        "case_merge_proposals",
        "disk_observations",
        "disk_observation_entries",
    ] {
        assert!(managed.has_table(table).unwrap(), "missing {table}");
    }
    assert!(managed.backup_path().is_none());
    drop(managed);
    fs::remove_file(path).unwrap();
}

#[test]
fn integrity_check_is_read_only_while_the_managed_database_is_online() {
    let path = path("online-integrity");
    let managed = DatabaseManager::open(&path).unwrap();
    let before = fs::metadata(&path).unwrap().permissions().readonly();

    assert_eq!(DatabaseManager::check_integrity(&path).unwrap(), vec!["ok"]);
    assert_eq!(managed.user_version().unwrap(), ekg_storage::SCHEMA_VERSION);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().readonly(),
        before
    );

    drop(managed);
    fs::remove_file(path).unwrap();
}

#[test]
fn schema_v5_migrates_after_backup_and_preserves_owned_history() {
    let path = path("v5");
    legacy_v5(&path);
    let managed = DatabaseManager::open(&path).unwrap();
    let backup = managed.backup_path().unwrap().to_path_buf();
    assert!(backup.exists());
    assert_eq!(managed.user_version().unwrap(), 8);
    assert_eq!(managed.quick_check().unwrap(), vec!["ok"]);
    assert_eq!(
        managed
            .connection()
            .query_row(
                "SELECT case_id FROM events WHERE aggregate_id='case-a'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap()
            .as_deref(),
        Some("case-a")
    );
    drop(managed);
    let backup_db = Connection::open(&backup).unwrap();
    assert_eq!(
        backup_db
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        backup_db
            .query_row("SELECT name FROM projects", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "Legacy"
    );
    drop(backup_db);
    fs::remove_file(path).unwrap();
    fs::remove_file(backup).unwrap();
}

#[test]
fn schema_v1_upgrades_through_all_compatibility_migrations() {
    let path = path("v1");
    legacy_v5(&path);
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    drop(db);
    let managed = DatabaseManager::open(&path).unwrap();
    assert_eq!(managed.user_version().unwrap(), 8);
    assert_eq!(managed.quick_check().unwrap(), vec!["ok"]);
    let backup = managed.backup_path().unwrap().to_path_buf();
    drop(managed);
    fs::remove_file(path).unwrap();
    fs::remove_file(backup).unwrap();
}

#[test]
fn fault_newer_and_corrupt_inputs_never_replace_the_original() {
    let fault_path = path("fault");
    legacy_v5(&fault_path);
    assert!(
        DatabaseManager::open_with_fault(&fault_path, Some(DatabaseFaultPoint::AfterBackup))
            .is_err()
    );
    let original = Connection::open(&fault_path).unwrap();
    assert_eq!(
        original
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        original
            .query_row("SELECT count(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(original);
    for entry in fs::read_dir(fault_path.parent().unwrap())
        .unwrap()
        .flatten()
    {
        if entry.file_name().to_string_lossy().contains("fault")
            && entry.path().extension().is_some_and(|value| value == "bak")
        {
            fs::remove_file(entry.path()).unwrap();
        }
    }
    fs::remove_file(&fault_path).unwrap();

    let commit_fault = path("before-commit");
    legacy_v5(&commit_fault);
    assert!(
        DatabaseManager::open_with_fault(&commit_fault, Some(DatabaseFaultPoint::BeforeCommit))
            .is_err()
    );
    let original = Connection::open(&commit_fault).unwrap();
    assert_eq!(
        original
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    drop(original);
    let backup = fs::read_dir(commit_fault.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|candidate| {
            candidate.file_name().is_some_and(|name| {
                name.to_string_lossy().starts_with(&format!(
                    "{}.pre-rust-v8-",
                    commit_fault.file_name().unwrap().to_string_lossy()
                ))
            })
        })
        .unwrap();
    let restored = path("restored");
    DatabaseManager::restore_backup(&backup, &restored).unwrap();
    let restored_db = Connection::open(&restored).unwrap();
    assert_eq!(
        restored_db
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    drop(restored_db);
    fs::remove_file(commit_fault).unwrap();
    fs::remove_file(backup).unwrap();
    fs::remove_file(restored).unwrap();

    let newer = path("newer");
    let db = Connection::open(&newer).unwrap();
    db.pragma_update(None, "user_version", 9).unwrap();
    drop(db);
    let before = fs::read(&newer).unwrap();
    assert!(DatabaseManager::open(&newer).is_err());
    assert_eq!(fs::read(&newer).unwrap(), before);
    fs::remove_file(newer).unwrap();

    let corrupt = path("corrupt");
    fs::write(&corrupt, b"not sqlite and must stay byte-identical").unwrap();
    let before = fs::read(&corrupt).unwrap();
    assert!(DatabaseManager::open(&corrupt).is_err());
    assert_eq!(fs::read(&corrupt).unwrap(), before);
    fs::remove_file(corrupt).unwrap();
}

fn legacy_v5(path: &std::path::Path) {
    let db = Connection::open(path).unwrap();
    db.execute_batch("PRAGMA user_version=5;
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,canonical_root TEXT UNIQUE,created_at TEXT);
      CREATE TABLE project_aliases(id TEXT PRIMARY KEY,project_id TEXT,root TEXT UNIQUE,created_at TEXT);
      CREATE TABLE cases(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,created_at TEXT);
      CREATE TABLE nodes(id TEXT PRIMARY KEY,case_id TEXT,type TEXT,status TEXT,data TEXT,created_at TEXT);
      CREATE TABLE edges(id TEXT PRIMARY KEY,case_id TEXT,source_id TEXT,relation TEXT,target_id TEXT,created_at TEXT);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT,type TEXT,aggregate_id TEXT,payload TEXT,occurred_at TEXT);
      CREATE TRIGGER events_reject_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
      INSERT INTO projects VALUES('project-a','Legacy',NULL,'/legacy','2026-07-16T00:00:00Z');
      INSERT INTO cases VALUES('case-a','project-a','Legacy Case','open','2026-07-16T00:00:00Z');
      INSERT INTO events(project_id,type,aggregate_id,payload,occurred_at) VALUES('project-a','case.created','case-a','{\"caseId\":\"case-a\"}','2026-07-16T00:00:00Z');").unwrap();
}

fn path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("ekg-schema-{label}-{}.db", std::process::id()))
}
