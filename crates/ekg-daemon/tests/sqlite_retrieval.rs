use ekg_daemon::{QueryRequest, RetrievalEngine};
use rusqlite::Connection;

#[test]
fn rust_reads_the_existing_core_tables_and_invalidates_by_revision() {
    let path = std::env::temp_dir().join(format!("ekg-rust-{}.db", std::process::id()));
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
         CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
         CREATE TABLE events (sequence INTEGER PRIMARY KEY, project_id TEXT, case_id TEXT);
         INSERT INTO cases VALUES ('case-a', 'project-a', '标准', 'verified', '2026-07-16T00:00:00Z');
         INSERT INTO nodes VALUES ('problem-a', 'case-a', 'Problem', 'open',
           '{\"summary\":\"轻量代码修复采用三级风险验证门禁\",\"domain\":\"workflow\"}',
           '2026-07-16T00:00:00Z');
         INSERT INTO events VALUES (1, 'project-a', 'case-a');",
    ).unwrap();
    drop(connection);

    let mut engine = RetrievalEngine::open(path.to_str().unwrap()).unwrap();
    let first = engine
        .query(QueryRequest {
            request_id: "one".into(),
            project_id: "project-a".into(),
            text: "轻量修复 三级验证门禁".into(),
            domain: Some("workflow".into()),
            limit: 5,
        })
        .unwrap();
    assert_eq!(first.case_ids, vec!["case-a"]);
    assert!(!first.cache_hit);

    let second = engine
        .query(QueryRequest {
            request_id: "two".into(),
            project_id: "project-a".into(),
            text: "轻量修复".into(),
            domain: None,
            limit: 5,
        })
        .unwrap();
    assert_eq!(second.case_ids, vec!["case-a"]);
    assert!(second.cache_hit);
    std::fs::remove_file(path).unwrap();
}
