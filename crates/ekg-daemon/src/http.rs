//! Authenticated loopback HTTP transport for the native EKG daemon.
//!
//! Policy and persistence stay behind [`RpcDispatcher`]. This module owns only
//! the bounded transport boundary: origin checks, authentication, replay,
//! response hardening, and daemon-local phase timing.

use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{io, net::SocketAddr};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use ekg_contracts::{PROTOCOL_VERSION, ReadOperation};
use serde_json::{Value, json};

use crate::protocol::{ProtocolError, ProtocolSession};

const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct DaemonHttpConfig {
    pub token: String,
    pub daemon_version: String,
    pub replay_capacity: usize,
}

pub trait RpcDispatcher: Send + Sync + 'static {
    fn dispatch(&self, operation: &ReadOperation) -> Result<Value, ProtocolError>;
}

pub struct RunningHttpServer {
    pub address: SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<io::Result<()>>,
}

impl RunningHttpServer {
    pub async fn close(mut self) -> io::Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.await.map_err(io::Error::other)?
    }
}

#[derive(Clone)]
struct HttpState {
    config: DaemonHttpConfig,
    session: Arc<Mutex<ProtocolSession>>,
    dispatcher: Arc<dyn RpcDispatcher>,
}

pub fn router(config: DaemonHttpConfig, dispatcher: Arc<dyn RpcDispatcher>) -> Router {
    assert!(!config.token.is_empty(), "daemon token is required");
    let replay_capacity = config.replay_capacity;
    Router::new()
        .route("/health", get(health))
        .route("/rpc", post(rpc))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(HttpState {
            config,
            session: Arc::new(Mutex::new(ProtocolSession::new(replay_capacity))),
            dispatcher,
        })
}

/// Starts the transport on IPv4 loopback only. Callers choose `port = 0` for
/// an ephemeral port and publish the returned address through the descriptor.
pub async fn serve_loopback(
    port: u16,
    config: DaemonHttpConfig,
    dispatcher: Arc<dyn RpcDispatcher>,
) -> io::Result<RunningHttpServer> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let (shutdown, receiver) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, router(config, dispatcher))
            .with_graceful_shutdown(async move {
                let _ = receiver.await;
            })
            .await
            .map_err(io::Error::other)
    });
    Ok(RunningHttpServer {
        address,
        shutdown: Some(shutdown),
        task,
    })
}

async fn health(State(state): State<HttpState>, headers: HeaderMap) -> Response {
    if !loopback_request(&headers) {
        return response(
            StatusCode::FORBIDDEN,
            json!({"ok": false, "error": {"code": "FORBIDDEN", "message": "Loopback Host required"}}),
            None,
        );
    }
    response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "protocolVersion": PROTOCOL_VERSION,
            "daemonVersion": state.config.daemon_version,
        }),
        None,
    )
}

async fn rpc(State(state): State<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
    let received = Instant::now();
    if !loopback_request(&headers) || !same_origin(&headers) {
        return response(
            StatusCode::FORBIDDEN,
            json!({"ok": false, "error": {"code": "FORBIDDEN", "message": "Loopback same-origin request required"}}),
            None,
        );
    }
    if !authorized(&headers, &state.config.token) {
        return response(
            StatusCode::UNAUTHORIZED,
            json!({"ok": false, "error": {"code": "UNAUTHORIZED", "message": "Bearer token required"}}),
            None,
        );
    }
    let line = match std::str::from_utf8(&body) {
        Ok(value) => value,
        Err(_) => {
            return response(
                StatusCode::BAD_REQUEST,
                json!({"ok": false, "error": {"code": "INVALID_JSON", "message": "Request body must be UTF-8 JSON"}}),
                None,
            );
        }
    };
    let queued = received.elapsed();
    let execution_started = Instant::now();
    let encoded = match state.session.lock() {
        Ok(mut session) => {
            session.handle_line(line, |operation| state.dispatcher.dispatch(operation))
        }
        Err(_) => serde_json::to_string(&json!({
            "ok": false,
            "requestId": "unknown",
            "error": {"code": "INTERNAL_ERROR", "message": "Unexpected service failure"},
        }))
        .expect("static response serializes"),
    };
    let execution = execution_started.elapsed();
    let serialization_started = Instant::now();
    let parsed = serde_json::from_str::<Value>(&encoded).unwrap_or_else(|_| {
        json!({
            "ok": false,
            "requestId": "unknown",
            "error": {"code": "INTERNAL_ERROR", "message": "Unexpected service failure"},
        })
    });
    let serialization = serialization_started.elapsed();
    let status = status_for(&parsed);
    let timing = format!(
        "queue;dur={:.3}, execution;dur={:.3}, serialization;dur={:.3}",
        queued.as_secs_f64() * 1_000.0,
        execution.as_secs_f64() * 1_000.0,
        serialization.as_secs_f64() * 1_000.0,
    );
    response(status, parsed, Some(&timing))
}

fn loopback_request(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let hostname = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or_default()
    };
    matches!(hostname, "127.0.0.1" | "localhost" | "::1")
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(host) = headers.get(header::HOST) else {
        return false;
    };
    let (Ok(origin), Ok(host)) = (origin.to_str(), host.to_str()) else {
        return false;
    };
    origin == format!("http://{host}")
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    constant_time_equal(value.as_bytes(), expected.as_bytes())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn status_for(body: &Value) -> StatusCode {
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        return StatusCode::OK;
    }
    match body
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "PROTOCOL_MISMATCH" | "OPERATION_CONFLICT" | "CONFLICT" => StatusCode::CONFLICT,
        "PAYLOAD_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        "INTERNAL_ERROR" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    }
}

fn response(status: StatusCode, body: Value, server_timing: Option<&str>) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'"),
    );
    if let Some(value) = server_timing.and_then(|value| HeaderValue::from_str(value).ok()) {
        headers.insert(HeaderName::from_static("server-timing"), value);
    }
    response
}
