use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, header};
use fishbowl_daemon::http::{DaemonHttpConfig, router};
use fishbowl_daemon::native::NativeDispatcher;
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn native_http_dispatches_a_transactional_write_then_reads_it_without_typescript() {
    let root = std::env::temp_dir().join(format!(
        "fishbowl-native-dispatch-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    let project_root = root.join("project");
    std::fs::create_dir_all(&project_root).unwrap();
    let database = root.join("knowledge.db");
    let dispatcher = Arc::new(NativeDispatcher::open(&database).unwrap());
    let app = router(
        DaemonHttpConfig {
            token: "native-token".into(),
            daemon_version: "stage7-test".into(),
            replay_capacity: 32,
            static_directory: None,
        },
        dispatcher,
    );

    let registered = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "register-1",
            "operation": "registerProject",
            "input": {
                "name": "Native Project",
                "root": project_root,
                "operationId": "register-operation-1"
            }
        }),
    )
    .await;
    assert_eq!(registered["ok"], true);
    let project_id = registered["result"]["id"].as_str().unwrap();

    let problem = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "problem-1",
            "operation": "recordProblem",
            "input": {
                "project": {"projectId": project_id},
                "operationId": "problem-operation-1",
                "caseTitle": "Native ownership",
                "data": {"summary": "Rust owns this write", "domain": "daemon"}
            }
        }),
    )
    .await;
    assert_eq!(problem["ok"], true);
    assert_eq!(problem["result"]["created"], true);
    let case_id = problem["result"]["caseId"].as_str().unwrap();

    let operation_result = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "operation-result-1",
            "operation": "getOperationResult",
            "input": {
                "project": {"projectId": project_id},
                "operationId": "problem-operation-1",
                "kind": "record_problem"
            }
        }),
    )
    .await;
    assert_eq!(operation_result["ok"], true);
    assert_eq!(operation_result["result"]["found"], true);
    assert_eq!(operation_result["result"]["result"]["caseId"], case_id);

    let invalid_finalize = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "invalid-finalize-1",
            "operation": "finalizeWork",
            "input": {
                "project": {"projectId": project_id},
                "operationId": "invalid-finalize-operation-1",
                "task": "finish native work",
                "outcome": "succeeded",
                "summary": "missing required evidence",
                "merge": {"status": "pending"}
            }
        }),
    )
    .await;
    assert_eq!(invalid_finalize["ok"], false);
    assert_eq!(invalid_finalize["error"]["code"], "VALIDATION_FAILED");
    assert!(
        invalid_finalize["error"]["message"]
            .as_str()
            .unwrap()
            .contains("commit")
    );

    let metrics = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "metrics-1",
            "operation": "getOperationMetrics",
            "input": {"project": {"projectId": project_id}}
        }),
    )
    .await;
    assert_eq!(metrics["ok"], true);
    assert!(metrics["result"].as_array().unwrap().iter().any(|item| {
        item["operation"] == "record_problem" && item["count"].as_u64().unwrap() >= 1
    }));
    assert!(metrics["result"].as_array().unwrap().iter().any(|item| {
        item["operation"] == "finalize_work" && item["errors"].as_u64().unwrap() >= 1
    }));

    let case_detail = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "case-1",
            "operation": "getCase",
            "input": {
                "project": {"projectId": project_id},
                "caseId": case_id,
                "detail": "graph"
            }
        }),
    )
    .await;
    assert_eq!(case_detail["ok"], true);
    assert_eq!(case_detail["result"]["nodes"][0]["type"], "Problem");

    let projects = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "projects-1",
            "operation": "listProjects",
            "input": {}
        }),
    )
    .await;
    assert_eq!(projects["result"][0]["name"], "Native Project");

    let query = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "query-1",
            "operation": "queryKnowledge",
            "input": {"project": {"projectId": project_id}, "text": "Rust owns"}
        }),
    )
    .await;
    assert_eq!(query["result"]["items"][0]["caseTitle"], "Native ownership");

    let report = project_root.join("failed-test.md");
    std::fs::write(
        &report,
        "# Failed test\nHypothesis: cached state\nChange: clear cache\nFailure: still fails\n",
    )
    .unwrap();
    let preview = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "preview-1",
            "operation": "previewImport",
            "input": {
                "project": {"projectId": project_id},
                "sources": [{"kind": "file", "path": report}]
            }
        }),
    )
    .await;
    assert_eq!(preview["ok"], true);
    let preview_id = preview["result"]["previewId"].as_str().unwrap();
    let proposal_id = preview["result"]["proposals"][0]["id"].as_str().unwrap();
    let restarted = router(
        DaemonHttpConfig {
            token: "native-token".into(),
            daemon_version: "stage7-test-restarted".into(),
            replay_capacity: 32,
            static_directory: None,
        },
        Arc::new(NativeDispatcher::open(&database).unwrap()),
    );
    let applied = call(
        &restarted,
        json!({
            "protocolVersion": 2,
            "requestId": "apply-1",
            "operation": "applyImport",
            "input": {
                "project": {"projectId": project_id},
                "previewId": preview_id,
                "proposalIds": [proposal_id],
                "operationId": "apply-operation-1"
            }
        }),
    )
    .await;
    assert_eq!(applied["ok"], true);

    let outside = root.join("outside.md");
    std::fs::write(&outside, "secret content").unwrap();
    let rejected = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "preview-outside",
            "operation": "previewImport",
            "input": {
                "project": {"projectId": project_id},
                "sources": [{"kind": "file", "path": outside}]
            }
        }),
    )
    .await;
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "PATH_OUTSIDE_PROJECT");
    assert!(!rejected.to_string().contains("secret content"));

    git(&project_root, &["init", "-q"]);
    let history = project_root.join("history.md");
    std::fs::write(&history, "# Baseline\n").unwrap();
    git(&project_root, &["add", "history.md"]);
    git(
        &project_root,
        &[
            "-c",
            "user.name=Fishbowl Test",
            "-c",
            "user.email=fishbowl@example.invalid",
            "commit",
            "-q",
            "-m",
            "baseline",
        ],
    );
    std::fs::write(
        &history,
        "# Failed test\nHypothesis: git source\nChange: native acquisition\nFailure: bounded fixture\n",
    )
    .unwrap();
    git(&project_root, &["add", "history.md"]);
    git(
        &project_root,
        &[
            "-c",
            "user.name=Fishbowl Test",
            "-c",
            "user.email=fishbowl@example.invalid",
            "commit",
            "-q",
            "-m",
            "failed test evidence",
        ],
    );
    let git_preview = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "preview-git",
            "operation": "previewImport",
            "input": {
                "project": {"projectId": project_id},
                "sources": [{"kind": "git", "range": "HEAD~1..HEAD"}]
            }
        }),
    )
    .await;
    assert_eq!(git_preview["ok"], true, "{git_preview}");

    let hostile_range = call(
        &app,
        json!({
            "protocolVersion": 2,
            "requestId": "preview-hostile-git",
            "operation": "previewImport",
            "input": {
                "project": {"projectId": project_id},
                "sources": [{"kind": "git", "range": "--help..HEAD"}]
            }
        }),
    )
    .await;
    assert_eq!(hostile_range["ok"], false);
    assert_eq!(hostile_range["error"]["code"], "INVALID_ARGUMENT");
    std::fs::remove_dir_all(root).unwrap();
}

fn git(root: &std::path::Path, arguments: &[&str]) {
    let status = std::process::Command::new("git")
        .args(arguments)
        .current_dir(root)
        .status()
        .unwrap();
    assert!(status.success(), "git {arguments:?} failed");
}

async fn call(app: &axum::Router, value: Value) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/rpc")
                .header(header::HOST, "127.0.0.1:43123")
                .header(header::AUTHORIZATION, "Bearer native-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
