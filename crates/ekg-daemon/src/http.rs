//! Authenticated loopback HTTP transport for the native EKG daemon.
//!
//! Policy and persistence stay behind [`RpcDispatcher`]. This module owns only
//! the bounded transport boundary: origin checks, authentication, replay,
//! response hardening, and daemon-local phase timing.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{io, net::SocketAddr};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, OriginalUri, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use ekg_contracts::{
    CaseDetailLevel, DaemonOperation, EmptyInput, ErrorCode, GetCaseInput, NodeStatus, NodeType,
    PROTOCOL_VERSION, ProjectReference, QueryKnowledgeInput, RecentActivityInput,
};
use futures_util::stream;
use serde_json::{Value, json};

use crate::protocol::{ProtocolError, ProtocolSession};

const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct DaemonHttpConfig {
    pub token: String,
    pub daemon_version: String,
    pub replay_capacity: usize,
    pub static_directory: Option<PathBuf>,
}

pub trait RpcDispatcher: Send + Sync + 'static {
    fn dispatch(&self, operation: &DaemonOperation) -> Result<Value, ProtocolError>;
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
    active_streams: Arc<AtomicUsize>,
}

pub fn router(config: DaemonHttpConfig, dispatcher: Arc<dyn RpcDispatcher>) -> Router {
    assert!(!config.token.is_empty(), "daemon token is required");
    let replay_capacity = config.replay_capacity;
    Router::new()
        .route("/health", get(health))
        .route("/rpc", post(rpc))
        .route("/api/v1/projects", get(browser_projects))
        .route("/api/v1/events", get(browser_events))
        .route("/api/v1/graph", get(browser_graph))
        .route("/api/v1/activity", get(browser_activity))
        .route("/api/v1/cases/{case_id}", get(browser_case))
        .route("/", get(browser_static))
        .route("/index.html", get(browser_static))
        .route("/styles.css", get(browser_static))
        .route("/app.js", get(browser_static))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(HttpState {
            config,
            session: Arc::new(Mutex::new(ProtocolSession::new(replay_capacity))),
            dispatcher,
            active_streams: Arc::new(AtomicUsize::new(0)),
        })
}

async fn browser_projects(State(state): State<HttpState>, headers: HeaderMap) -> Response {
    if !browser_request(&headers) {
        return forbidden();
    }
    match state
        .dispatcher
        .dispatch(&DaemonOperation::ListProjects(EmptyInput::default()))
    {
        Ok(projects) => browser_response(StatusCode::OK, json!({"projects": projects})),
        Err(error) => browser_protocol_error(error),
    }
}

async fn browser_events(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Query(parameters): Query<HashMap<String, String>>,
) -> Response {
    if !browser_request(&headers) {
        return forbidden();
    }
    let Some(project_id) = parameters
        .get("project_id")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
    else {
        return browser_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "INVALID_ARGUMENT", "message": "project_id is required"}),
        );
    };
    let query_after = match parameters
        .get("after")
        .map(|value| value.parse::<u64>())
        .transpose()
    {
        Ok(value) => value.unwrap_or(0),
        Err(_) => {
            return browser_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "INVALID_ARGUMENT", "message": "after must be non-negative"}),
            );
        }
    };
    let after = match headers.get("last-event-id") {
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
        {
            Some(value) => value,
            None => return invalid_browser_argument("Last-Event-ID is invalid"),
        },
        None => query_after,
    };
    let project = ProjectReference {
        project_id: Some(project_id.to_owned()),
        project_root: None,
    };
    if let Err(error) = state
        .dispatcher
        .dispatch(&DaemonOperation::ResolveProject(project.clone()))
    {
        return browser_protocol_error(error);
    }
    if state.active_streams.fetch_add(1, Ordering::AcqRel) >= 32 {
        state.active_streams.fetch_sub(1, Ordering::AcqRel);
        return browser_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "STREAM_LIMIT", "message": "Too many active event streams"}),
        );
    }
    struct StreamGuard(Arc<AtomicUsize>);
    impl Drop for StreamGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }
    struct EventState {
        cursor: u64,
        pending: VecDeque<Value>,
        dispatcher: Arc<dyn RpcDispatcher>,
        project: ProjectReference,
        _guard: StreamGuard,
    }
    let source = stream::unfold(
        EventState {
            cursor: after,
            pending: VecDeque::new(),
            dispatcher: state.dispatcher,
            project,
            _guard: StreamGuard(state.active_streams),
        },
        |mut state| async move {
            if state.pending.is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                match state
                    .dispatcher
                    .dispatch(&DaemonOperation::ListRecentActivity(RecentActivityInput {
                        project: state.project.clone(),
                        after_sequence: Some(state.cursor),
                        limit: Some(100),
                    })) {
                    Ok(result) => {
                        state.pending.extend(
                            result
                                .get("events")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        );
                    }
                    Err(_) => {
                        let event = Event::default()
                            .event("stream_error")
                            .data("{\"error\":\"INTERNAL_ERROR\"}");
                        return Some((Ok::<_, Infallible>(event), state));
                    }
                }
            }
            let event = if let Some(value) = state.pending.pop_front() {
                state.cursor = value
                    .get("sequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.cursor);
                Event::default()
                    .event("knowledge_event")
                    .id(state.cursor.to_string())
                    .data(value.to_string())
            } else {
                Event::default().comment("heartbeat")
            };
            Some((Ok::<_, Infallible>(event), state))
        },
    );
    let mut response = Sse::new(source)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response();
    apply_browser_headers(response.headers_mut());
    response
}

async fn browser_graph(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Query(parameters): Query<HashMap<String, String>>,
) -> Response {
    if !browser_request(&headers) {
        return forbidden();
    }
    let project = match browser_project(&parameters) {
        Ok(value) => value,
        Err(message) => return invalid_browser_argument(message),
    };
    let query = QueryKnowledgeInput {
        project: project.clone(),
        text: optional_parameter(&parameters, "q"),
        domain: optional_parameter(&parameters, "domain"),
        node_types: match parse_node_types(parameters.get("types")) {
            Ok(value) => value,
            Err(message) => return invalid_browser_argument(message),
        },
        statuses: match parse_statuses(parameters.get("statuses")) {
            Ok(value) => value,
            Err(message) => return invalid_browser_argument(message),
        },
        file: None,
        command: None,
        fingerprint: None,
        limit: Some(browser_limit(&parameters)),
    };
    let result = match state
        .dispatcher
        .dispatch(&DaemonOperation::QueryKnowledge(query))
    {
        Ok(value) => value,
        Err(error) => return browser_protocol_error(error),
    };
    let mut case_ids = Vec::new();
    for case_id in result
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("caseId").and_then(Value::as_str))
    {
        if !case_ids.iter().any(|known| known == case_id) {
            case_ids.push(case_id.to_owned());
        }
    }
    let mut cases = Vec::with_capacity(case_ids.len());
    for case_id in case_ids {
        let mut detail = match state
            .dispatcher
            .dispatch(&DaemonOperation::GetCase(GetCaseInput {
                project: project.clone(),
                case_id,
                detail: Some(CaseDetailLevel::Graph),
                history_limit: None,
                history_before_sequence: None,
            })) {
            Ok(value) => value,
            Err(error) => return browser_protocol_error(error),
        };
        let mut graph_truncated = false;
        if let Some(nodes) = detail.get_mut("nodes").and_then(Value::as_array_mut) {
            graph_truncated |= nodes.len() > 100;
            nodes.truncate(100);
        }
        if let Some(edges) = detail.get_mut("edges").and_then(Value::as_array_mut) {
            graph_truncated |= edges.len() > 200;
            edges.truncate(200);
        }
        if let Some(object) = detail.as_object_mut() {
            object.insert("graphTruncated".into(), Value::Bool(graph_truncated));
        }
        cases.push(detail);
    }
    let as_of = as_of_sequence(&state, &project).unwrap_or(0);
    browser_response(
        StatusCode::OK,
        json!({
            "projectId": project.project_id,
            "cases": cases,
            "limit": result.get("limit").cloned().unwrap_or(json!(25)),
            "truncated": result.get("truncated").cloned().unwrap_or(json!(false)),
            "asOfSequence": as_of,
        }),
    )
}

async fn browser_activity(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Query(parameters): Query<HashMap<String, String>>,
) -> Response {
    if !browser_request(&headers) {
        return forbidden();
    }
    let project = match browser_project(&parameters) {
        Ok(value) => value,
        Err(message) => return invalid_browser_argument(message),
    };
    let after = match parse_u64_parameter(&parameters, "after", 0) {
        Ok(value) => value,
        Err(message) => return invalid_browser_argument(message),
    };
    let mut result = match state
        .dispatcher
        .dispatch(&DaemonOperation::ListRecentActivity(RecentActivityInput {
            project: project.clone(),
            after_sequence: Some(after),
            limit: Some(browser_limit(&parameters)),
        })) {
        Ok(value) => value,
        Err(error) => return browser_protocol_error(error),
    };
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "asOfSequence".into(),
            json!(as_of_sequence(&state, &project).unwrap_or(0)),
        );
    }
    browser_response(StatusCode::OK, result)
}

async fn browser_case(
    State(state): State<HttpState>,
    headers: HeaderMap,
    AxumPath(case_id): AxumPath<String>,
    Query(parameters): Query<HashMap<String, String>>,
) -> Response {
    if !browser_request(&headers) {
        return forbidden();
    }
    let project = match browser_project(&parameters) {
        Ok(value) => value,
        Err(message) => return invalid_browser_argument(message),
    };
    if case_id.is_empty() || case_id.len() > 4096 {
        return invalid_browser_argument("case id is invalid");
    }
    let history_limit = browser_limit_named(&parameters, "history_limit", 50);
    let history_before_sequence = match parameters.get("history_before") {
        Some(_) => match parse_u64_parameter(&parameters, "history_before", 0) {
            Ok(0) | Err(_) => return invalid_browser_argument("history_before is invalid"),
            Ok(value) => Some(value),
        },
        None => None,
    };
    let mut detail = match state
        .dispatcher
        .dispatch(&DaemonOperation::GetCase(GetCaseInput {
            project: project.clone(),
            case_id,
            detail: Some(CaseDetailLevel::Full),
            history_limit: Some(history_limit),
            history_before_sequence,
        })) {
        Ok(value) => value,
        Err(error) => return browser_protocol_error(error),
    };
    if let Some(object) = detail.as_object_mut() {
        object.insert(
            "asOfSequence".into(),
            json!(as_of_sequence(&state, &project).unwrap_or(0)),
        );
    }
    browser_response(StatusCode::OK, detail)
}

async fn browser_static(
    State(state): State<HttpState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
) -> Response {
    if !browser_request(&headers) {
        return forbidden();
    }
    let Some(directory) = state.config.static_directory.as_ref() else {
        return browser_response(
            StatusCode::NOT_FOUND,
            json!({"error": "NOT_FOUND", "message": "Static assets are not installed"}),
        );
    };
    let (file, content_type) = match uri.path() {
        "/" | "/index.html" => ("index.html", "text/html; charset=utf-8"),
        "/styles.css" => ("styles.css", "text/css; charset=utf-8"),
        "/app.js" => ("app.js", "text/javascript; charset=utf-8"),
        _ => return browser_response(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"})),
    };
    let bytes = match tokio::fs::read(directory.join(file)).await {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => bytes,
        Ok(_) => {
            return browser_response(
                StatusCode::INSUFFICIENT_STORAGE,
                json!({"error": "RESPONSE_TOO_LARGE"}),
            );
        }
        Err(_) => return browser_response(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"})),
    };
    let mut response = (StatusCode::OK, bytes).into_response();
    apply_browser_headers(response.headers_mut());
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
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

fn browser_request(headers: &HeaderMap) -> bool {
    loopback_request(headers) && same_origin(headers)
}

fn forbidden() -> Response {
    browser_response(
        StatusCode::FORBIDDEN,
        json!({"error": "FORBIDDEN", "message": "Loopback same-origin request required"}),
    )
}

fn browser_protocol_error(error: ProtocolError) -> Response {
    let status = match error.code {
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
        ErrorCode::Conflict | ErrorCode::OperationConflict => StatusCode::CONFLICT,
        _ => StatusCode::BAD_REQUEST,
    };
    browser_response(
        status,
        json!({"error": error.code, "message": error.message}),
    )
}

fn browser_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    apply_browser_headers(response.headers_mut());
    response
}

fn apply_browser_headers(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
        ),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
}

fn browser_project(parameters: &HashMap<String, String>) -> Result<ProjectReference, &'static str> {
    let Some(project_id) = parameters
        .get("project_id")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
    else {
        return Err("project_id is required");
    };
    Ok(ProjectReference {
        project_id: Some(project_id.to_owned()),
        project_root: None,
    })
}

fn browser_limit(parameters: &HashMap<String, String>) -> usize {
    browser_limit_named(parameters, "limit", 25)
}

fn browser_limit_named(parameters: &HashMap<String, String>, name: &str, fallback: usize) -> usize {
    parameters
        .get(name)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
        .min(100)
}

fn parse_u64_parameter(
    parameters: &HashMap<String, String>,
    name: &str,
    fallback: u64,
) -> Result<u64, &'static str> {
    parameters
        .get(name)
        .map(|value| value.parse::<u64>())
        .transpose()
        .map(|value| value.unwrap_or(fallback))
        .map_err(|_| "numeric query parameter is invalid")
}

fn optional_parameter(parameters: &HashMap<String, String>, name: &str) -> Option<String> {
    parameters
        .get(name)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && value.len() <= 1024)
        .map(str::to_owned)
}

fn parse_node_types(value: Option<&String>) -> Result<Option<Vec<NodeType>>, &'static str> {
    value
        .map(|value| {
            value
                .split(',')
                .filter(|value| !value.is_empty())
                .map(|value| match value {
                    "Problem" => Ok(NodeType::Problem),
                    "Attempt" => Ok(NodeType::Attempt),
                    "RootCause" => Ok(NodeType::RootCause),
                    "Solution" => Ok(NodeType::Solution),
                    "Verification" => Ok(NodeType::Verification),
                    "SuccessCase" => Ok(NodeType::SuccessCase),
                    "Guardrail" => Ok(NodeType::Guardrail),
                    "Artifact" => Ok(NodeType::Artifact),
                    _ => Err("node type is invalid"),
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
}

fn parse_statuses(value: Option<&String>) -> Result<Option<Vec<NodeStatus>>, &'static str> {
    value
        .map(|value| {
            value
                .split(',')
                .filter(|value| !value.is_empty())
                .map(|value| match value {
                    "open" => Ok(NodeStatus::Open),
                    "candidate" => Ok(NodeStatus::Candidate),
                    "verified" => Ok(NodeStatus::Verified),
                    "regressed" => Ok(NodeStatus::Regressed),
                    "retired" => Ok(NodeStatus::Retired),
                    _ => Err("node status is invalid"),
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
}

fn as_of_sequence(state: &HttpState, project: &ProjectReference) -> Result<u64, ProtocolError> {
    let result = state
        .dispatcher
        .dispatch(&DaemonOperation::ListRecentActivity(RecentActivityInput {
            project: project.clone(),
            after_sequence: Some(0),
            limit: Some(1),
        }))?;
    Ok(result
        .get("nextSequence")
        .and_then(Value::as_u64)
        .unwrap_or(0))
}

fn invalid_browser_argument(message: &'static str) -> Response {
    browser_response(
        StatusCode::BAD_REQUEST,
        json!({"error": "INVALID_ARGUMENT", "message": message}),
    )
}
