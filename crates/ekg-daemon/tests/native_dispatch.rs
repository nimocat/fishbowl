use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, header};
use ekg_daemon::http::{DaemonHttpConfig, router};
use ekg_daemon::native::NativeDispatcher;
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn native_http_dispatches_a_transactional_write_then_reads_it_without_typescript() {
    let root = std::env::temp_dir().join(format!(
        "ekg-native-dispatch-{}-{}",
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
        },
        dispatcher,
    );

    let registered = call(
        &app,
        json!({
            "protocolVersion": 1,
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
            "protocolVersion": 1,
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

    let case_detail = call(
        &app,
        json!({
            "protocolVersion": 1,
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
            "protocolVersion": 1,
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
            "protocolVersion": 1,
            "requestId": "query-1",
            "operation": "queryKnowledge",
            "input": {"project": {"projectId": project_id}, "text": "Rust owns"}
        }),
    )
    .await;
    assert_eq!(query["result"]["items"][0]["caseTitle"], "Native ownership");
    std::fs::remove_dir_all(root).unwrap();
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
