use fishbowl_contracts::{
    NodeStatus, NodeType, ProjectReference, QueryKnowledgeInput, QueryResultMode,
    RetrievalMatchKind, RetrievalMode,
};
use fishbowl_core::ExpansionConfig;
use fishbowl_storage::ReadRepository;
use rusqlite::Connection;

#[test]
fn complete_query_is_project_scoped_composable_and_deterministic() {
    let path = database("complete");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let input = QueryKnowledgeInput {
        project: ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        },
        text: Some("camera session".into()),
        domain: Some("ios".into()),
        node_types: Some(vec![NodeType::Solution]),
        statuses: Some(vec![NodeStatus::Verified]),
        file: Some("CameraView.swift".into()),
        command: Some("xcodebuild".into()),
        fingerprint: Some("camera hang".into()),
        limit: Some(1),
        result_mode: None,
    };
    let first = repository.query_knowledge(&input).unwrap();
    let second = repository.query_knowledge(&input).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.items[0].project_id, "project-a");
    assert_eq!(first.items[0].case_id, "case-a");
    assert_eq!(first.items[0].node.id, "solution-a");
    assert_eq!(first.items[0].case_title, "Camera lifecycle");
    assert_eq!(
        first.diagnostics.as_ref().unwrap().mode,
        RetrievalMode::Exact
    );
    for kind in [
        RetrievalMatchKind::ExactText,
        RetrievalMatchKind::ExactFingerprint,
        RetrievalMatchKind::ExactFile,
        RetrievalMatchKind::ExactCommand,
        RetrievalMatchKind::VerifiedTrust,
    ] {
        assert!(
            first.items[0]
                .why_matched
                .iter()
                .any(|reason| reason.kind == kind)
        );
    }
    assert!(!first.truncated);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn query_defaults_to_one_best_node_per_case_and_allows_node_expansion() {
    let path = database("case-diversity");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "INSERT INTO cases VALUES ('case-c','project-a','Camera fallback','candidate','2026-07-16T02:00:00Z');
         INSERT INTO nodes VALUES ('problem-c','case-c','Problem','open','{\"summary\":\"camera session fallback\",\"domain\":\"ios\"}','2026-07-16T02:00:00Z');
         INSERT INTO node_search VALUES ('project-a','problem-c','Camera fallback','camera session fallback ios');",
    ).unwrap();
    for index in 0..70 {
        let node_id = format!("crowd-{index:02}");
        let created_at = format!("2026-07-16T{:02}:{:02}:00Z", 3 + index / 60, index % 60);
        connection.execute(
            "INSERT INTO nodes VALUES (?, 'case-a', 'Attempt', 'candidate', '{\"summary\":\"camera session crowd\"}', ?)",
            rusqlite::params![node_id, created_at],
        ).unwrap();
        connection.execute(
            "INSERT INTO node_search VALUES ('project-a', ?, 'Camera lifecycle', 'camera session crowd')",
            rusqlite::params![node_id],
        ).unwrap();
    }
    drop(connection);
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let mut input = QueryKnowledgeInput {
        project: ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        },
        text: Some("camera session".into()),
        domain: None,
        node_types: None,
        statuses: None,
        file: None,
        command: None,
        fingerprint: None,
        result_mode: None,
        limit: Some(5),
    };

    let diverse = repository.query_knowledge(&input).unwrap();
    assert_eq!(
        diverse
            .items
            .iter()
            .map(|item| &item.case_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        diverse.items.len()
    );
    assert!(diverse.items.iter().any(|item| item.case_id == "case-a"));
    assert!(diverse.items.iter().any(|item| item.case_id == "case-c"));

    input.result_mode = Some(QueryResultMode::Nodes);
    let expanded = repository.query_knowledge(&input).unwrap();
    assert!(
        expanded
            .items
            .iter()
            .filter(|item| item.case_id == "case-a")
            .count()
            > 1
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn lexical_relevance_outranks_newer_creation_time() {
    let path = database("lexical-rank");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "INSERT INTO cases VALUES ('case-relevant','project-a','Rare exact solution','candidate','2026-01-01T00:00:00Z');
         INSERT INTO nodes VALUES ('node-relevant','case-relevant','Solution','candidate','{\"summary\":\"rare exact solution rare exact solution rare exact solution\"}','2026-01-01T00:00:00Z');
         INSERT INTO node_search VALUES ('project-a','node-relevant','Rare exact solution','rare exact solution rare exact solution rare exact solution');
         INSERT INTO cases VALUES ('case-newer-noise','project-a','Recent note','candidate','2026-07-18T00:00:00Z');
         INSERT INTO nodes VALUES ('node-newer-noise','case-newer-noise','Problem','open','{\"summary\":\"rare exact solution plus generic common build words\"}','2026-07-18T00:00:00Z');
         INSERT INTO node_search VALUES ('project-a','node-newer-noise','Recent note','rare exact solution generic common build test record history');",
    ).unwrap();
    drop(connection);
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .query_knowledge(&QueryKnowledgeInput {
            project: ProjectReference {
                project_id: Some("project-a".into()),
                project_root: None,
            },
            text: Some("rare exact solution".into()),
            domain: None,
            node_types: None,
            statuses: None,
            file: None,
            command: None,
            fingerprint: None,
            limit: Some(2),
            result_mode: None,
        })
        .unwrap();
    assert_eq!(result.items[0].case_id, "case-relevant");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn aliases_resolve_and_identical_other_project_text_never_leaks() {
    let path = database("alias");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .query_knowledge(&QueryKnowledgeInput {
            project: ProjectReference {
                project_id: None,
                project_root: Some("/synthetic/a-worktree".into()),
            },
            text: Some("camera session".into()),
            domain: None,
            node_types: None,
            statuses: None,
            file: None,
            command: None,
            fingerprint: None,
            limit: Some(10),
            result_mode: None,
        })
        .unwrap();
    assert!(!result.items.is_empty());
    assert!(
        result
            .items
            .iter()
            .all(|item| item.project_id == "project-a")
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn limit_has_stable_truncation_without_mutating_schema_v7() {
    let path = database("limit");
    let before = metadata(&path);
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .query_knowledge(&QueryKnowledgeInput {
            project: ProjectReference {
                project_id: Some("project-a".into()),
                project_root: None,
            },
            text: None,
            domain: None,
            node_types: None,
            statuses: None,
            file: None,
            command: None,
            fingerprint: None,
            limit: Some(1),
            result_mode: None,
        })
        .unwrap();
    assert_eq!(result.items.len(), 1);
    assert!(result.truncated);
    drop(repository);
    assert_eq!(metadata(&path), before);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn hierarchy_load_is_project_scoped_and_uses_event_revision() {
    let path = database("hierarchy");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let hierarchy = repository
        .load_hierarchy(&ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        })
        .unwrap();
    let snapshot = String::from_utf8(hierarchy.snapshot_json().unwrap()).unwrap();
    assert!(snapshot.contains("case-a"));
    assert!(!snapshot.contains("case-b"));
    assert_eq!(
        hierarchy.branch_source_revision("project-a", "ios"),
        Some(1)
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn graph_expansion_loads_only_selected_project_owned_cases() {
    let path = database("graph-expansion");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .expand_case_graph(
            &ProjectReference {
                project_id: Some("project-a".into()),
                project_root: None,
            },
            &["case-a".into(), "case-b".into()],
            &["problem-a".into()],
            &[],
            ExpansionConfig::default(),
        )
        .unwrap();
    let ids = result
        .hits
        .iter()
        .map(|hit| hit.node_id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"root-a"));
    assert!(ids.contains(&"solution-a"));
    assert!(!ids.contains(&"solution-b"));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn production_query_routes_then_expands_to_a_filtered_multihop_solution() {
    let path = database("hybrid-query");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let result = repository
        .query_knowledge(&QueryKnowledgeInput {
            project: ProjectReference {
                project_id: Some("project-a".into()),
                project_root: None,
            },
            text: Some("synchronous binding".into()),
            domain: Some("ios".into()),
            node_types: Some(vec![NodeType::Solution]),
            statuses: Some(vec![NodeStatus::Verified]),
            file: None,
            command: None,
            fingerprint: None,
            limit: Some(5),
            result_mode: None,
        })
        .unwrap();

    assert_eq!(result.items[0].node.id, "solution-a");
    assert!(
        result.items[0]
            .why_matched
            .iter()
            .any(|reason| format!("{:?}", reason.kind) == "PprPath")
    );
    assert!(result.items[0].why_matched.iter().any(|reason| {
        reason.kind == RetrievalMatchKind::KShellCommunity && reason.value == "ios:k1:case-a"
    }));
    assert_eq!(
        result.items[0].supporting_path,
        vec!["root-a", "solution-a"]
    );
    assert_eq!(
        result.diagnostics.as_ref().unwrap().mode,
        RetrievalMode::Hybrid
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn retrieval_cache_rebuilds_when_the_project_event_revision_changes() {
    let path = database("cache-revision");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let input = QueryKnowledgeInput {
        project: ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        },
        text: Some("instrumentation".into()),
        domain: Some("observability".into()),
        node_types: Some(vec![NodeType::Solution]),
        statuses: Some(vec![NodeStatus::Verified]),
        file: None,
        command: None,
        fingerprint: None,
        limit: Some(5),
        result_mode: None,
    };
    assert!(repository.query_knowledge(&input).unwrap().items.is_empty());

    let writer = Connection::open(&path).unwrap();
    writer
        .execute_batch(
            "INSERT INTO cases VALUES ('case-new','project-a','Metrics pipeline','verified','2026-07-16T01:00:00Z');
             INSERT INTO nodes VALUES ('problem-new','case-new','Problem','open','{\"summary\":\"instrumentation gap\",\"domain\":\"observability\"}','2026-07-16T01:00:00Z');
             INSERT INTO nodes VALUES ('solution-new','case-new','Solution','verified','{\"summary\":\"bounded instrumentation pipeline\"}','2026-07-16T01:01:00Z');
             INSERT INTO events VALUES (2,'project-a','case-new');",
        )
        .unwrap();
    drop(writer);

    let result = repository.query_knowledge(&input).unwrap();
    assert_eq!(result.items[0].node.id, "solution-new");
    assert_eq!(result.diagnostics.unwrap().candidate_case_count, 1);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn unmatched_text_returns_a_bounded_deterministic_exact_fallback() {
    let path = database("fallback");
    let repository = ReadRepository::open(path.to_str().unwrap()).unwrap();
    let input = QueryKnowledgeInput {
        project: ProjectReference {
            project_id: Some("project-a".into()),
            project_root: None,
        },
        text: Some("unseen-vocabulary-without-route".into()),
        domain: Some("ios".into()),
        node_types: None,
        statuses: None,
        file: None,
        command: None,
        fingerprint: None,
        limit: Some(5),
        result_mode: None,
    };
    let first = repository.query_knowledge(&input).unwrap();
    let second = repository.query_knowledge(&input).unwrap();
    assert_eq!(first, second);
    assert!(first.items.is_empty());
    assert_eq!(
        first.diagnostics.unwrap().mode,
        RetrievalMode::ExactFallback
    );
    std::fs::remove_file(path).unwrap();
}

fn database(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fishbowl-storage-{label}-{}.db",
        std::process::id()
    ));
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
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
         INSERT INTO projects VALUES ('project-a','A',NULL,'/synthetic/a','2026-07-16T00:00:00Z');
         INSERT INTO projects VALUES ('project-b','B',NULL,'/synthetic/b','2026-07-16T00:00:00Z');
         INSERT INTO project_aliases VALUES ('alias-a','project-a','/synthetic/a-worktree','2026-07-16T00:00:00Z');
         INSERT INTO cases VALUES ('case-a','project-a','Camera lifecycle','verified','2026-07-16T00:00:00Z');
         INSERT INTO cases VALUES ('case-a2','project-a','Older camera note','candidate','2026-07-15T00:00:00Z');
         INSERT INTO cases VALUES ('case-b','project-b','Same text elsewhere','verified','2026-07-16T00:00:00Z');
         INSERT INTO nodes VALUES ('problem-a','case-a','Problem','open','{\"summary\":\"camera session hang\",\"domain\":\"ios\",\"file\":\"CameraView.swift\"}','2026-07-16T00:00:00Z');
         INSERT INTO nodes VALUES ('root-a','case-a','RootCause','verified','{\"explanation\":\"session binding is synchronous\"}','2026-07-16T00:01:00Z');
         INSERT INTO nodes VALUES ('solution-a','case-a','Solution','verified','{\"summary\":\"camera session fix\",\"file\":\"CameraView.swift\",\"command\":\"xcodebuild\"}','2026-07-16T00:02:00Z');
         INSERT INTO nodes VALUES ('problem-a2','case-a2','Problem','open','{\"summary\":\"other note\",\"domain\":\"ios\",\"file\":\"CameraView.swift\"}','2026-07-15T00:00:00Z');
         INSERT INTO nodes VALUES ('solution-b','case-b','Solution','verified','{\"summary\":\"camera session fix\",\"file\":\"CameraView.swift\"}','2026-07-16T00:03:00Z');
         INSERT INTO edges VALUES ('edge-root','case-a','root-a','CAUSES','problem-a','2026-07-16T00:01:00Z');
         INSERT INTO edges VALUES ('edge-solution','case-a','solution-a','ADDRESSES','root-a','2026-07-16T00:02:00Z');
         INSERT INTO node_search VALUES ('project-a','problem-a','Camera lifecycle','camera session hang ios CameraView.swift');
         INSERT INTO node_search VALUES ('project-a','solution-a','Camera lifecycle','camera session fix CameraView.swift xcodebuild');
         INSERT INTO node_search VALUES ('project-b','solution-b','Same text elsewhere','camera session fix CameraView.swift');
         INSERT INTO fingerprints VALUES ('fp-a','project-a','problem-a','v1','camera hang','2026-07-16T00:00:00Z');
         INSERT INTO command_runs VALUES ('run-a','project-a','case-a',NULL,'[\"xcodebuild\"]','/synthetic/a',0,NULL,1,'pass',NULL,NULL,'2026-07-16T00:00:00Z','2026-07-16T00:00:00Z');
         INSERT INTO events VALUES (1,'project-a','case-a');"
    ).unwrap();
    path
}

fn metadata(path: &std::path::Path) -> (i64, i64, i64) {
    let connection = Connection::open(path).unwrap();
    let user: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let app: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .unwrap();
    let changes: i64 = connection
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    (user, app, changes)
}
