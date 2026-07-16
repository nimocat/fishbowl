use ekg_contracts::{NodeStatus, NodeType, ProjectReference, QueryKnowledgeInput};
use ekg_storage::ReadRepository;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

#[test]
fn production_query_pipeline_meets_real_engineering_recall_and_budget_gates() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/retrieval/engineering_query_golden.json"
    ))
    .unwrap();
    let path = database(&fixture);
    let strict_exact_recalled = strict_exact_recall(&path, &fixture);
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let records = fixture["records"].as_array().unwrap();
    let mut query_count = 0;
    let mut recalled = 0;
    for record in records {
        for query in record["queries"].as_array().unwrap() {
            query_count += 1;
            let result = repository
                .query_knowledge(&QueryKnowledgeInput {
                    project: ProjectReference {
                        project_id: Some("engineering-golden".into()),
                        project_root: None,
                    },
                    text: Some(query.as_str().unwrap().to_owned()),
                    domain: Some(record["domain"].as_str().unwrap().to_owned()),
                    node_types: Some(vec![NodeType::Solution]),
                    statuses: Some(vec![NodeStatus::Verified]),
                    file: None,
                    command: None,
                    fingerprint: None,
                    limit: Some(5),
                })
                .unwrap();
            if result
                .items
                .iter()
                .any(|item| item.case_id == record["caseId"].as_str().unwrap())
            {
                recalled += 1;
            }
            let diagnostics = result.diagnostics.unwrap();
            assert!(diagnostics.candidate_case_count <= 64);
            assert!(diagnostics.visited_nodes <= 256);
            assert!(diagnostics.visited_edges <= 1024);
            assert!(diagnostics.iterations <= 20);
        }
    }
    let recall = recalled as f64 / query_count as f64;
    eprintln!(
        "EKG_PRODUCTION_ENGINEERING_GOLDEN records={} queries={} strict_exact_recalled={} strict_exact_recall={:.3} hybrid_recalled={} hybrid_recall_at_5={recall:.3}",
        records.len(),
        query_count,
        strict_exact_recalled,
        strict_exact_recalled as f64 / query_count as f64,
        recalled
    );
    assert!(query_count >= 120);
    assert!(recall >= 0.95, "production recall@5 was {recall:.3}");
    assert!(recalled >= strict_exact_recalled + 20);
    std::fs::remove_file(path).unwrap();
}

fn strict_exact_recall(path: &std::path::Path, fixture: &Value) -> usize {
    let connection = Connection::open(path).unwrap();
    fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| {
            let expected = format!("solution-{}", record["caseId"].as_str().unwrap());
            record["queries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|query| {
                    let query_text = query.as_str().unwrap();
                    let match_query = query_text
                        .split_whitespace()
                        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                        .collect::<Vec<_>>()
                        .join(" AND ");
                    let found = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM node_search WHERE node_search MATCH ? AND project_id = 'engineering-golden' AND node_id = ?)",
                        params![match_query, expected],
                        |row| row.get::<_, i64>(0),
                    );
                    found.unwrap_or(0) == 1
                })
                .count()
        })
        .sum()
}

fn database(fixture: &Value) -> std::path::PathBuf {
    let path =
        std::env::temp_dir().join(format!("ekg-engineering-golden-{}.db", std::process::id()));
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "PRAGMA user_version = 7;
             PRAGMA application_id = 1162561281;
             CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, canonical_root TEXT, created_at TEXT);
             CREATE TABLE project_aliases (id TEXT PRIMARY KEY, project_id TEXT, root TEXT, created_at TEXT);
             CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
             CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
             CREATE TABLE edges (id TEXT PRIMARY KEY, case_id TEXT, source_id TEXT, relation TEXT, target_id TEXT, created_at TEXT);
             CREATE TABLE fingerprints (id TEXT PRIMARY KEY, project_id TEXT, problem_node_id TEXT, algorithm TEXT, value TEXT, created_at TEXT);
             CREATE TABLE command_runs (id TEXT PRIMARY KEY, project_id TEXT, case_id TEXT, attempt_node_id TEXT, command TEXT, working_directory TEXT, exit_status INTEGER, signal TEXT, duration_ms INTEGER, excerpt TEXT, raw_log_path TEXT, raw_log_digest TEXT, started_at TEXT, finished_at TEXT);
             CREATE TABLE events (sequence INTEGER PRIMARY KEY, project_id TEXT, case_id TEXT);
             CREATE VIRTUAL TABLE node_search USING fts5(project_id UNINDEXED, node_id UNINDEXED, title, body, tokenize='unicode61');
             INSERT INTO projects VALUES ('engineering-golden','Engineering Golden',NULL,'/synthetic/engineering','2026-07-17T00:00:00Z');",
        )
        .unwrap();
    for (index, record) in fixture["records"].as_array().unwrap().iter().enumerate() {
        let case_id = record["caseId"].as_str().unwrap();
        let problem_id = format!("problem-{case_id}");
        let solution_id = format!("solution-{case_id}");
        let edge_id = format!("edge-{case_id}");
        let title = record["title"].as_str().unwrap();
        let text = record["text"].as_str().unwrap();
        let domain = record["domain"].as_str().unwrap();
        connection
            .execute(
                "INSERT INTO cases VALUES (?, 'engineering-golden', ?, 'verified', '2026-07-17T00:00:00Z')",
                params![case_id, title],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO nodes VALUES (?, ?, 'Problem', 'open', ?, '2026-07-17T00:00:00Z')",
                params![
                    problem_id,
                    case_id,
                    json!({"summary": title, "domain": domain}).to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO nodes VALUES (?, ?, 'Solution', 'verified', ?, '2026-07-17T00:01:00Z')",
                params![solution_id, case_id, json!({"summary": text}).to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO edges VALUES (?, ?, ?, 'ADDRESSES', ?, '2026-07-17T00:01:00Z')",
                params![edge_id, case_id, solution_id, problem_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO node_search VALUES ('engineering-golden', ?, ?, ?)",
                params![solution_id, title, text],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO events VALUES (?, 'engineering-golden', ?)",
                params![index as i64 + 1, case_id],
            )
            .unwrap();
    }
    drop(connection);
    path
}
