use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use ekg_contracts::ReadOperation;
use ekg_daemon::http::{DaemonHttpConfig, RpcDispatcher, router, serve_loopback};
use ekg_daemon::protocol::ProtocolError;
use serde_json::{Value, json};
use tower::ServiceExt;

struct FixtureDispatcher;

impl RpcDispatcher for FixtureDispatcher {
    fn dispatch(&self, _: &ReadOperation) -> Result<Value, ProtocolError> {
        Ok(json!({"items": []}))
    }
}

fn app() -> axum::Router {
    router(
        DaemonHttpConfig {
            token: "a".repeat(64),
            daemon_version: "stage7-test".into(),
            replay_capacity: 8,
        },
        Arc::new(FixtureDispatcher),
    )
}

fn config() -> DaemonHttpConfig {
    DaemonHttpConfig {
        token: "a".repeat(64),
        daemon_version: "stage7-test".into(),
        replay_capacity: 8,
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
        "protocolVersion": 1,
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
    assert_eq!(value["protocolVersion"], 1);
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
        .replace("\"protocolVersion\":1", "\"protocolVersion\":999"));
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

#[tokio::test]
async fn native_listener_binds_ipv4_loopback_only() {
    let running = serve_loopback(0, config(), Arc::new(FixtureDispatcher))
        .await
        .unwrap();
    assert_eq!(running.address.ip(), std::net::Ipv4Addr::LOCALHOST);
    running.close().await.unwrap();
}
