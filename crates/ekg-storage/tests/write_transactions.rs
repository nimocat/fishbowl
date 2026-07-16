use std::collections::BTreeMap;

use ekg_contracts::{
    NodeStatus, ProjectReference, RecordArtifactInput, RecordAttemptInput,
    RecordCommandResultInput, RecordCommandStartedInput, RecordGuardrailInput, RecordProblemInput,
    RecordRootCauseInput, RecordSolutionInput, RecordVerificationInput, SourceKey,
    WriteArtifactData, WriteAttemptData, WriteGuardrailCriteria, WriteGuardrailData,
    WriteProblemData, WriteRootCauseData, WriteSolutionData, WriteVerificationData,
};
use ekg_storage::{WriteFaultPoint, WriteRepository};
use rusqlite::Connection;

#[test]
fn problem_and_attempt_writes_are_atomic_idempotent_and_ordered() {
    let path = database("success");
    let mut repository = WriteRepository::open(path.to_str().unwrap()).unwrap();
    let problem = repository
        .record_problem(problem_input("op-problem"))
        .unwrap();
    assert!(problem.created);
    let replay = repository
        .record_problem(problem_input("op-problem"))
        .unwrap();
    assert!(!replay.created);
    assert_eq!(problem.node_id, replay.node_id);

    let attempt = repository
        .record_attempt(RecordAttemptInput {
            project: project("project-a"),
            operation_id: Some("op-attempt".into()),
            source_key: Some(SourceKey {
                kind: "test".into(),
                key: "attempt-1".into(),
            }),
            case_id: problem.case_id.clone(),
            problem_id: problem.node_id.clone(),
            previous_attempt_id: None,
            data: WriteAttemptData {
                hypothesis: "session binding blocks".into(),
                change: "move binding".into(),
                outcome: "failed".into(),
                command: Some(vec!["xcodebuild".into(), "TOKEN=secret-value".into()]),
                failure_explanation: Some("password=secret-value".into()),
                decisive_difference: None,
            },
        })
        .unwrap();
    assert!(attempt.created);

    drop(repository);
    let connection = Connection::open(&path).unwrap();
    let node_count: i64 = connection
        .query_row("SELECT count(*) FROM nodes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(node_count, 2);
    let relations = connection
        .prepare("SELECT relation FROM edges ORDER BY created_at, id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(relations, vec!["ATTEMPTS_TO_SOLVE"]);
    let event_types = connection
        .prepare("SELECT type FROM events ORDER BY sequence")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        event_types,
        vec!["case.created", "node.added", "node.added", "edge.added"]
    );
    assert!(!database_text(&connection).contains("secret-value"));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn invalid_cross_project_and_source_type_conflicts_leave_zero_mutation() {
    let path = database("invalid");
    let before = counts(&path);
    let mut repository = WriteRepository::open(path.to_str().unwrap()).unwrap();
    let mut invalid = problem_input("invalid");
    invalid.data.summary.clear();
    assert!(repository.record_problem(invalid).is_err());
    assert_eq!(counts(&path), before);

    let mut foreign = problem_input("foreign");
    foreign.case_id = Some("case-b".into());
    assert!(repository.record_problem(foreign).is_err());
    assert_eq!(counts(&path), before);

    let created = repository
        .record_problem(problem_input("source-owner"))
        .unwrap();
    let mut conflicting = problem_input("source-conflict");
    conflicting.source_key = Some(SourceKey {
        kind: "test".into(),
        key: "problem-1".into(),
    });
    conflicting.data.summary = "changed input".into();
    let replay = repository.record_problem(conflicting).unwrap();
    assert_eq!(replay.node_id, created.node_id);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn every_injected_problem_failure_rolls_back_the_complete_transaction() {
    for point in [
        WriteFaultPoint::AfterCase,
        WriteFaultPoint::AfterNode,
        WriteFaultPoint::AfterEvent,
        WriteFaultPoint::BeforeOperationResult,
    ] {
        let path = database(&format!("fault-{point:?}"));
        let before = counts(&path);
        let mut repository = WriteRepository::open(path.to_str().unwrap()).unwrap();
        assert!(
            repository
                .record_problem_with_fault(problem_input("fault-op"), Some(point))
                .is_err()
        );
        drop(repository);
        assert_eq!(counts(&path), before, "fault point {point:?}");
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn command_lifecycle_is_project_owned_redacted_and_idempotent() {
    let path = database("command");
    let mut repository = WriteRepository::open(path.to_str().unwrap()).unwrap();
    let started = repository
        .record_command_started(RecordCommandStartedInput {
            project: project("project-a"),
            command_run_id: "run-1".into(),
            command: vec!["tool".into(), "TOKEN=secret-value".into()],
            working_directory: "/project/a".into(),
            started_at: "2026-07-16T00:00:00Z".into(),
        })
        .unwrap();
    assert_eq!(started.command_run_id, "run-1");
    let input = RecordCommandResultInput {
        project: project("project-a"),
        command_run_id: Some("run-1".into()),
        operation_id: Some("command-op".into()),
        case_id: None,
        attempt_id: None,
        command: vec!["tool".into(), "--password=secret-value".into()],
        working_directory: "/project/a".into(),
        exit_status: Some(0),
        signal: None,
        duration_ms: 10,
        excerpt: "authorization: secret-value".into(),
        raw_log_path: None,
        raw_log_digest: None,
        started_at: "2026-07-16T00:00:00Z".into(),
        finished_at: "2026-07-16T00:00:01Z".into(),
    };
    assert!(
        repository
            .record_command_result(input.clone())
            .unwrap()
            .created
    );
    assert!(!repository.record_command_result(input).unwrap().created);
    drop(repository);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM command_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!database_text(&connection).contains("secret-value"));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn causal_node_chain_preserves_trust_edges_evidence_artifacts_and_guardrails() {
    let path = database("causal-chain");
    let mut repository = WriteRepository::open(path.to_str().unwrap()).unwrap();
    let problem = repository
        .record_problem(problem_input("chain-problem"))
        .unwrap();
    let attempt = repository
        .record_attempt(RecordAttemptInput {
            project: project("project-a"),
            operation_id: Some("chain-attempt".into()),
            source_key: None,
            case_id: problem.case_id.clone(),
            problem_id: problem.node_id.clone(),
            previous_attempt_id: None,
            data: WriteAttemptData {
                hypothesis: "queue ownership".into(),
                change: "inspect queue".into(),
                outcome: "failed".into(),
                command: None,
                failure_explanation: Some("did not move binding".into()),
                decisive_difference: None,
            },
        })
        .unwrap();
    let invalid_root = RecordRootCauseInput {
        project: project("project-a"),
        operation_id: Some("invalid-root".into()),
        source_key: None,
        case_id: problem.case_id.clone(),
        problem_id: problem.node_id.clone(),
        failed_attempt_ids: vec![attempt.node_id.clone()],
        status: Some(NodeStatus::Verified),
        human_confirmed: false,
        data: WriteRootCauseData {
            explanation: "session graph is synchronous".into(),
            evidence: vec!["failed trace".into()],
            rejected_alternatives: Vec::new(),
            confidence: 0.95,
        },
    };
    assert!(repository.record_root_cause(invalid_root).is_err());
    let root = repository
        .record_root_cause(RecordRootCauseInput {
            operation_id: Some("root".into()),
            human_confirmed: true,
            ..RecordRootCauseInput {
                project: project("project-a"),
                operation_id: None,
                source_key: None,
                case_id: problem.case_id.clone(),
                problem_id: problem.node_id.clone(),
                failed_attempt_ids: vec![attempt.node_id.clone()],
                status: Some(NodeStatus::Verified),
                human_confirmed: false,
                data: WriteRootCauseData {
                    explanation: "session graph is synchronous".into(),
                    evidence: vec!["failed trace".into()],
                    rejected_alternatives: Vec::new(),
                    confidence: 0.95,
                },
            }
        })
        .unwrap();
    let solution = repository
        .record_solution(RecordSolutionInput {
            project: project("project-a"),
            operation_id: Some("solution".into()),
            source_key: None,
            case_id: problem.case_id.clone(),
            root_cause_id: root.node_id.clone(),
            data: WriteSolutionData {
                summary: "bind asynchronously".into(),
                applicability: vec!["camera preview".into()],
                limitations: vec!["session must remain serial".into()],
                side_effects: Vec::new(),
                decisive_difference: "moves graph construction off render path".into(),
                applicability_boundary: BTreeMap::new(),
                human_verification_required: true,
                non_automatable_reason: None,
            },
        })
        .unwrap();
    let automated = repository
        .record_verification(RecordVerificationInput {
            project: project("project-a"),
            operation_id: Some("verify-auto".into()),
            source_key: None,
            case_id: problem.case_id.clone(),
            solution_id: solution.node_id.clone(),
            data: WriteVerificationData {
                kind: "automated".into(),
                succeeded: true,
                human_confirmed: false,
                environment: BTreeMap::new(),
                command: Some(vec!["cargo".into(), "test".into()]),
                exit_status: Some(0),
                source_revision: None,
                excerpt: Some("passed".into()),
            },
        })
        .unwrap();
    let human = repository
        .record_verification(RecordVerificationInput {
            project: project("project-a"),
            operation_id: Some("verify-human".into()),
            source_key: None,
            case_id: problem.case_id.clone(),
            solution_id: solution.node_id.clone(),
            data: WriteVerificationData {
                kind: "human".into(),
                succeeded: true,
                human_confirmed: true,
                environment: BTreeMap::new(),
                command: None,
                exit_status: None,
                source_revision: None,
                excerpt: Some("preview is responsive".into()),
            },
        })
        .unwrap();
    assert_eq!(human.promotion.status, NodeStatus::Verified);
    let artifact = repository
        .record_artifact(RecordArtifactInput {
            project: project("project-a"),
            operation_id: Some("artifact".into()),
            source_key: None,
            case_id: problem.case_id.clone(),
            verification_id: automated.node_id,
            data: WriteArtifactData {
                kind: "report".into(),
                uri: "https://example.invalid/report".into(),
                digest: None,
                media_type: Some("application/json".into()),
            },
            metadata: BTreeMap::new(),
            is_external: true,
        })
        .unwrap();
    assert!(artifact.created);
    let guardrail = repository
        .record_guardrail(RecordGuardrailInput {
            project: project("project-a"),
            operation_id: Some("guardrail".into()),
            source_key: None,
            case_id: problem.case_id,
            root_cause_id: root.node_id,
            status: Some(NodeStatus::Candidate),
            data: WriteGuardrailData {
                guidance: "do not bind synchronously".into(),
                enforcement: "block".into(),
                criteria: WriteGuardrailCriteria {
                    task_includes: vec!["camera".into()],
                    ..WriteGuardrailCriteria::default()
                },
            },
        })
        .unwrap();
    assert!(guardrail.created);
    drop(repository);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM evidence", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM artifacts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM guardrails", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    std::fs::remove_file(path).unwrap();
}

fn problem_input(operation_id: &str) -> RecordProblemInput {
    RecordProblemInput {
        project: project("project-a"),
        operation_id: Some(operation_id.into()),
        source_key: Some(SourceKey {
            kind: "test".into(),
            key: "problem-1".into(),
        }),
        case_id: None,
        case_title: Some("Camera lifecycle".into()),
        data: WriteProblemData {
            summary: "camera password=secret-value".into(),
            symptoms: vec!["token: secret-value".into()],
            first_observed_at: None,
            domain: Some("ios".into()),
            fingerprint: Some("camera-hang".into()),
        },
    }
}

fn project(id: &str) -> ProjectReference {
    ProjectReference {
        project_id: Some(id.into()),
        project_root: None,
    }
}

fn database(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ekg-write-{label}-{}.db", std::process::id()));
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA user_version=7;
             CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, canonical_root TEXT UNIQUE, created_at TEXT);
             CREATE TABLE project_aliases (id TEXT PRIMARY KEY, project_id TEXT, root TEXT UNIQUE, created_at TEXT);
             CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
             CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
             CREATE TABLE edges (id TEXT PRIMARY KEY, case_id TEXT, source_id TEXT, relation TEXT, target_id TEXT, created_at TEXT, UNIQUE(case_id,source_id,relation,target_id));
             CREATE TABLE fingerprints (id TEXT PRIMARY KEY, project_id TEXT, problem_node_id TEXT, algorithm TEXT, value TEXT, created_at TEXT, UNIQUE(project_id,algorithm,value));
             CREATE TABLE source_keys (id TEXT PRIMARY KEY, project_id TEXT, source_kind TEXT, source_key TEXT, node_id TEXT, created_at TEXT, UNIQUE(project_id,source_kind,source_key));
             CREATE TABLE operation_results (id TEXT PRIMARY KEY, project_id TEXT, operation_id TEXT, kind TEXT, result TEXT, created_at TEXT, UNIQUE(project_id,operation_id));
             CREATE TABLE command_runs (id TEXT PRIMARY KEY, project_id TEXT, case_id TEXT, attempt_node_id TEXT, command TEXT, working_directory TEXT, exit_status INTEGER, signal TEXT, duration_ms INTEGER, excerpt TEXT, raw_log_path TEXT, raw_log_digest TEXT, started_at TEXT, finished_at TEXT);
             CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT, node_id TEXT, kind TEXT, uri TEXT, digest TEXT, is_external INTEGER, metadata TEXT, created_at TEXT);
             CREATE TABLE evidence (id TEXT PRIMARY KEY, project_id TEXT, node_id TEXT, kind TEXT, command TEXT, exit_status INTEGER, data TEXT, created_at TEXT);
             CREATE TABLE guardrails (id TEXT PRIMARY KEY, project_id TEXT, node_id TEXT UNIQUE, enforcement TEXT, criteria TEXT, created_at TEXT);
             CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, type TEXT, aggregate_id TEXT, payload TEXT, occurred_at TEXT, case_id TEXT);
             CREATE VIRTUAL TABLE node_search USING fts5(project_id UNINDEXED,node_id UNINDEXED,title,body,tokenize='unicode61');
             INSERT INTO projects VALUES ('project-a','A',NULL,'/project/a','2026-07-16T00:00:00Z');
             INSERT INTO projects VALUES ('project-b','B',NULL,'/project/b','2026-07-16T00:00:00Z');
             INSERT INTO cases VALUES ('case-b','project-b','Foreign','open','2026-07-16T00:00:00Z');",
        )
        .unwrap();
    path
}

fn counts(path: &std::path::Path) -> Vec<i64> {
    let connection = Connection::open(path).unwrap();
    [
        "cases",
        "nodes",
        "edges",
        "events",
        "operation_results",
        "source_keys",
    ]
    .iter()
    .map(|table| {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    })
    .collect()
}

fn database_text(connection: &Connection) -> String {
    let mut all = String::new();
    for (table, columns) in [
        ("nodes", "data"),
        ("events", "payload"),
        ("operation_results", "result"),
        ("command_runs", "command || excerpt"),
    ] {
        let mut statement = connection
            .prepare(&format!("SELECT {columns} FROM {table}"))
            .unwrap();
        for value in statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
        {
            all.push_str(&value.unwrap());
        }
    }
    all
}
