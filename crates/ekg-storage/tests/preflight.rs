use ekg_contracts::{PreflightInput, ProjectReference};
use ekg_storage::ReadRepository;
use rusqlite::{Connection, params};

#[test]
fn verified_blocking_guardrails_are_complete_and_independent_of_limits() {
    let path = database("block");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .preflight(&PreflightInput {
            project: ProjectReference {
                project_id: Some("project-a".into()),
                project_root: None,
            },
            task_description: "CoreML 真机精度验证".into(),
            changed_files: Some(vec!["Sources/Inference.swift".into()]),
            command: Some(vec!["xcodebuild".into(), "test".into()]),
            fingerprint: None,
            limit: Some(1),
            detail: None,
        })
        .unwrap();
    assert!(result.blocked);
    assert_eq!(result.cards.len(), 1);
    assert_eq!(result.cards[0].case_id, "case-block");
    assert!(
        result.cards[0]
            .why_matched
            .iter()
            .any(|reason| format!("{:?}", reason.kind) == "BlockingGuardrail")
    );
    assert!(serde_json::to_vec(&result).unwrap().len() < 12 * 1024);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn candidate_and_warning_guardrails_never_block() {
    let path = database("warn");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .preflight(&PreflightInput {
            project: ProjectReference {
                project_id: Some("project-a".into()),
                project_root: None,
            },
            task_description: "deploy docs".into(),
            changed_files: None,
            command: None,
            fingerprint: None,
            limit: Some(5),
            detail: None,
        })
        .unwrap();
    assert!(!result.blocked);
    assert!(result.guardrails.iter().all(|guardrail| !guardrail.blocks));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn preflight_cache_is_content_free_and_invalidates_on_project_revision() {
    let path = database("cache");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let input = PreflightInput {
        project: ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        },
        task_description: "CoreML 真机精度验证".into(),
        changed_files: Some(vec!["Sources/Inference.swift".into()]),
        command: Some(vec!["xcodebuild".into()]),
        fingerprint: None,
        limit: Some(5),
        detail: None,
    };
    let first = repository.preflight_with_metrics(&input).unwrap();
    let second = repository.preflight_with_metrics(&input).unwrap();
    assert!(!first.metrics.cache_hit);
    assert!(second.metrics.cache_hit);
    assert_eq!(first.result, second.result);
    assert!(second.metrics.candidate_count > 0);
    assert_eq!(second.metrics.card_count, second.result.cards.len());

    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO events VALUES (2, 'project-a', 'case-block')",
            [],
        )
        .unwrap();
    let invalidated = repository.preflight_with_metrics(&input).unwrap();
    assert!(!invalidated.metrics.cache_hit);
    std::fs::remove_file(path).unwrap();
}

fn database(label: &str) -> std::path::PathBuf {
    let path =
        std::env::temp_dir().join(format!("ekg-preflight-{label}-{}.db", std::process::id()));
    let mut connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "PRAGMA user_version = 7;
         CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, canonical_root TEXT, created_at TEXT);
         CREATE TABLE project_aliases (id TEXT PRIMARY KEY, project_id TEXT, root TEXT, created_at TEXT);
         CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
         CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
         CREATE TABLE fingerprints (id TEXT PRIMARY KEY, project_id TEXT, problem_node_id TEXT, algorithm TEXT, value TEXT, created_at TEXT);
         CREATE TABLE command_runs (id TEXT PRIMARY KEY, project_id TEXT, case_id TEXT, attempt_node_id TEXT, command TEXT, working_directory TEXT, exit_status INTEGER, signal TEXT, duration_ms INTEGER, excerpt TEXT, raw_log_path TEXT, raw_log_digest TEXT, started_at TEXT, finished_at TEXT);
         CREATE TABLE guardrails (id TEXT PRIMARY KEY, project_id TEXT, node_id TEXT, enforcement TEXT, criteria TEXT, created_at TEXT);
         CREATE TABLE events (sequence INTEGER PRIMARY KEY, project_id TEXT, case_id TEXT);
         CREATE VIRTUAL TABLE node_search USING fts5(project_id UNINDEXED, node_id UNINDEXED, title, body, tokenize='unicode61');
         INSERT INTO projects VALUES ('project-a','A',NULL,'/synthetic/a','2026-07-16T00:00:00Z');
         INSERT INTO cases VALUES ('case-block','project-a','CoreML device rule','verified','2026-01-01T00:00:00Z');
         INSERT INTO nodes VALUES ('guard-block','case-block','Guardrail','verified','{\"guidance\":\"physical device only\"}','2026-01-01T00:00:00Z');
         INSERT INTO guardrails VALUES ('rule-block','project-a','guard-block','block','{\"taskIncludes\":[\"CoreML\"],\"taskIncludesAny\":[\"真机\",\"physical device\"],\"commandIncludes\":[\"xcodebuild\"],\"fileIncludesAny\":[\"Inference.swift\",\"ModelRunner.swift\"]}','2026-01-01T00:00:00Z');
         INSERT INTO node_search VALUES ('project-a','guard-block','CoreML device rule','CoreML 真机 physical device xcodebuild Inference.swift');
         INSERT INTO cases VALUES ('case-warn','project-a','Docs warning','candidate','2026-07-16T00:00:00Z');
         INSERT INTO nodes VALUES ('guard-warn','case-warn','Guardrail','candidate','{\"guidance\":\"review docs\"}','2026-07-16T00:00:00Z');
         INSERT INTO guardrails VALUES ('rule-warn','project-a','guard-warn','warn','{\"taskIncludes\":[\"deploy\"]}','2026-07-16T00:00:00Z');
         INSERT INTO node_search VALUES ('project-a','guard-warn','Docs warning','deploy docs review');
         INSERT INTO events VALUES (1,'project-a','case-block');",
    ).unwrap();
    let transaction = connection.transaction().unwrap();
    {
        let mut insert_case = transaction
            .prepare(
                "INSERT INTO cases VALUES (?, 'project-a', ?, 'candidate', '2026-07-16T00:00:00Z')",
            )
            .unwrap();
        let mut insert_node = transaction
            .prepare(
                "INSERT INTO nodes VALUES (?, ?, 'Problem', 'open', ?, '2026-07-16T00:00:00Z')",
            )
            .unwrap();
        let mut insert_search = transaction
            .prepare("INSERT INTO node_search VALUES ('project-a', ?, ?, ?)")
            .unwrap();
        for index in 0..101 {
            let case_id = format!("unrelated-{index:03}");
            let node_id = format!("unrelated-node-{index:03}");
            let body = format!("common build test fix record {index}");
            insert_case
                .execute(params![case_id, format!("Common {index}")])
                .unwrap();
            insert_node
                .execute(params![
                    node_id,
                    case_id,
                    format!("{{\"summary\":\"{body}\"}}")
                ])
                .unwrap();
            insert_search
                .execute(params![node_id, format!("Common {index}"), body])
                .unwrap();
        }
    }
    transaction.commit().unwrap();
    path
}
