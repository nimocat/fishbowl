use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use fishbowl_contracts::DaemonOperation;
use fishbowl_daemon::http::{DaemonHttpConfig, RpcDispatcher, router, serve_loopback};
use fishbowl_daemon::protocol::ProtocolError;
use serde_json::{Value, json};
use tower::ServiceExt;

struct FixtureDispatcher;

struct SlowDispatcher;

impl RpcDispatcher for SlowDispatcher {
    fn dispatch(&self, _: &DaemonOperation) -> Result<Value, ProtocolError> {
        std::thread::sleep(Duration::from_millis(250));
        Ok(json!({"items": [], "limit": 25, "truncated": false}))
    }
}

impl RpcDispatcher for FixtureDispatcher {
    fn dispatch(&self, operation: &DaemonOperation) -> Result<Value, ProtocolError> {
        Ok(match operation {
            DaemonOperation::ListProjects(_) => json!([{
                "id": "project-a", "name": "Project A", "description": null,
                "root": "/project-a", "createdAt": "2026-07-16T00:00:00Z", "aliases": []
            }]),
            DaemonOperation::ResolveProject(_) => json!({
                "id": "project-a", "name": "Project A", "description": null,
                "root": "/project-a", "createdAt": "2026-07-16T00:00:00Z"
            }),
            DaemonOperation::ListRecentActivity(_) => json!({
                "events": [], "limit": 25, "truncated": false, "nextSequence": 0
            }),
            _ => json!({"items": [], "limit": 25, "truncated": false}),
        })
    }
}

fn app() -> axum::Router {
    router(
        DaemonHttpConfig {
            token: "a".repeat(64),
            daemon_version: "stage7-test".into(),
            replay_capacity: 8,
            static_directory: None,
        },
        Arc::new(FixtureDispatcher),
    )
}

fn config() -> DaemonHttpConfig {
    DaemonHttpConfig {
        token: "a".repeat(64),
        daemon_version: "stage7-test".into(),
        replay_capacity: 8,
        static_directory: None,
    }
}

fn rpc(body: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/rpc")
        .header(header::HOST, "127.0.0.1:43123")
        .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .unwrap()
}

fn valid_request(id: &str, text: &str) -> String {
    json!({
        "protocolVersion": 2,
        "requestId": id,
        "operation": "queryKnowledge",
        "input": {"project": {"projectId": "project-a"}, "text": text}
    })
    .to_string()
}

#[tokio::test]
async fn health_is_bounded_but_rpc_requires_loopback_host_origin_and_bearer() {
    let health = app()
        .oneshot(
            Request::builder()
                .uri("/health")
                .header(header::HOST, "127.0.0.1:43123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(health.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(health.into_body(), 4096).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["protocolVersion"], 2);
    assert_eq!(value["daemonVersion"], "stage7-test");
    assert!(value.get("token").is_none());

    let mut missing_auth = rpc(&valid_request("auth-1", "safe"));
    missing_auth.headers_mut().remove(header::AUTHORIZATION);
    assert_eq!(
        app().oneshot(missing_auth).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    let mut hostile_host = rpc(&valid_request("host-1", "safe"));
    hostile_host
        .headers_mut()
        .insert(header::HOST, "example.com".parse().unwrap());
    assert_eq!(
        app().oneshot(hostile_host).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    let mut hostile_origin = rpc(&valid_request("origin-1", "safe"));
    hostile_origin
        .headers_mut()
        .insert(header::ORIGIN, "http://example.com".parse().unwrap());
    assert_eq!(
        app().oneshot(hostile_origin).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn request_bounds_protocol_and_content_aware_replay_are_enforced() {
    let oversized = rpc(&valid_request("large-1", &"x".repeat(70 * 1024)));
    assert_eq!(
        app().oneshot(oversized).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );

    let mismatch = rpc(&valid_request("version-1", "safe")
        .replace("\"protocolVersion\":2", "\"protocolVersion\":999"));
    assert_eq!(
        app().oneshot(mismatch).await.unwrap().status(),
        StatusCode::CONFLICT
    );

    let shared = app();
    assert_eq!(
        shared
            .clone()
            .oneshot(rpc(&valid_request("replay-1", "first")))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let conflict = shared
        .oneshot(rpc(&valid_request("replay-1", "changed-secret")))
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let body = to_bytes(conflict.into_body(), 4096).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("OPERATION_CONFLICT"));
    assert!(!text.contains("changed-secret"));
}

#[tokio::test]
async fn daemon_phase_metrics_are_exposed_without_claiming_mcp_host_time() {
    let response = app()
        .oneshot(rpc(&valid_request("metrics-1", "safe")))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let timing = response.headers()["server-timing"].to_str().unwrap();
    assert!(timing.contains("queue;dur="));
    assert!(timing.contains("execution;dur="));
    assert!(timing.contains("serialization;dur="));
    assert!(!timing.contains("mcp"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn sustained_rpc_work_never_blocks_the_loopback_health_path() {
    let shared = router(config(), Arc::new(SlowDispatcher));
    let started = Instant::now();
    let slow = tokio::spawn(
        shared
            .clone()
            .oneshot(rpc(&valid_request("slow-1", "bounded scan"))),
    );
    tokio::time::sleep(Duration::from_millis(10)).await;
    let health = shared
        .oneshot(
            Request::builder()
                .uri("/health")
                .header(header::HOST, "127.0.0.1:43123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(slow.await.unwrap().unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn native_listener_binds_ipv4_loopback_only() {
    let running = serve_loopback(0, config(), Arc::new(FixtureDispatcher))
        .await
        .unwrap();
    assert_eq!(running.address.ip(), std::net::Ipv4Addr::LOCALHOST);
    running.close().await.unwrap();
}

#[tokio::test]
async fn browser_read_api_and_sse_are_served_by_the_native_router() {
    let projects = app()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects")
                .header(header::HOST, "127.0.0.1:43123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(projects.status(), StatusCode::OK);
    let body = to_bytes(projects.into_body(), 4096).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["projects"][0]["id"], "project-a");

    let events = app()
        .oneshot(
            Request::builder()
                .uri("/api/v1/events?project_id=project-a&after=0")
                .header(header::HOST, "127.0.0.1:43123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::OK);
    assert_eq!(events.headers()[header::CONTENT_TYPE], "text/event-stream");
}
