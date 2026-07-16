use std::time::Instant;

use ekg_contracts::{ProjectReference, QueryKnowledgeInput};
use ekg_storage::ReadRepository;
use rusqlite::{Connection, params};

#[test]
fn complete_query_response_meets_cold_and_warm_budgets_at_ten_thousand_cases() {
    let path = std::env::temp_dir().join(format!("ekg-full-query-perf-{}.db", std::process::id()));
    let mut connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "PRAGMA user_version = 7;
         CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, canonical_root TEXT, created_at TEXT);
         CREATE TABLE project_aliases (id TEXT PRIMARY KEY, project_id TEXT, root TEXT, created_at TEXT);
         CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
         CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
         CREATE TABLE fingerprints (id TEXT PRIMARY KEY, project_id TEXT, problem_node_id TEXT, algorithm TEXT, value TEXT, created_at TEXT);
         CREATE TABLE command_runs (id TEXT PRIMARY KEY, project_id TEXT, case_id TEXT, attempt_node_id TEXT, command TEXT, working_directory TEXT, exit_status INTEGER, signal TEXT, duration_ms INTEGER, excerpt TEXT, raw_log_path TEXT, raw_log_digest TEXT, started_at TEXT, finished_at TEXT);
         CREATE VIRTUAL TABLE node_search USING fts5(project_id UNINDEXED, node_id UNINDEXED, title, body, tokenize='unicode61');
         INSERT INTO projects VALUES ('project-a','A',NULL,'/synthetic/a','2026-07-16T00:00:00Z');",
    ).unwrap();
    let transaction = connection.transaction().unwrap();
    {
        let mut insert_case = transaction
            .prepare("INSERT INTO cases VALUES (?, 'project-a', ?, 'candidate', ?)")
            .unwrap();
        let mut insert_node = transaction
            .prepare("INSERT INTO nodes VALUES (?, ?, 'Problem', 'open', ?, ?)")
            .unwrap();
        let mut insert_search = transaction
            .prepare("INSERT INTO node_search VALUES ('project-a', ?, ?, ?)")
            .unwrap();
        for number in 0..10_000 {
            let case_id = format!("case-{number:05}");
            let node_id = format!("node-{number:05}");
            let created_at = format!("2026-07-16T00:{:02}:{:02}Z", number % 60, number % 60);
            let body = if number == 4_242 {
                "unique camera session target".to_owned()
            } else {
                format!("unrelated engineering record {number:05}")
            };
            insert_case
                .execute(params![case_id, format!("Case {number}"), created_at])
                .unwrap();
            insert_node
                .execute(params![
                    node_id,
                    case_id,
                    format!("{{\"summary\":\"{body}\",\"domain\":\"perf\"}}"),
                    created_at
                ])
                .unwrap();
            insert_search
                .execute(params![node_id, format!("Case {number}"), body])
                .unwrap();
        }
    }
    transaction.commit().unwrap();
    drop(connection);

    let started = Instant::now();
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let first = repository.query_knowledge(&request()).unwrap();
    let cold_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(first.items[0].case_id, "case-04242");
    let mut warm = Vec::with_capacity(1000);
    for _ in 0..1000 {
        let started = Instant::now();
        repository.query_knowledge(&request()).unwrap();
        warm.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    warm.sort_by(f64::total_cmp);
    let p50 = warm[499];
    let p95 = warm[949];
    let p99 = warm[989];
    eprintln!(
        "EKG_RUST_FULL_QUERY cold_ms={cold_ms:.3} warm_p50_ms={p50:.3} warm_p95_ms={p95:.3} warm_p99_ms={p99:.3}"
    );
    let cold_budget = if cfg!(debug_assertions) {
        2000.0
    } else {
        250.0
    };
    assert!(cold_ms < cold_budget);
    assert!(p95 < 50.0);
    std::fs::remove_file(path).unwrap();
}

fn request() -> QueryKnowledgeInput {
    QueryKnowledgeInput {
        project: ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        },
        text: Some("unique camera session target".into()),
        domain: None,
        node_types: None,
        statuses: None,
        file: None,
        command: None,
        fingerprint: None,
        limit: Some(5),
    }
}
