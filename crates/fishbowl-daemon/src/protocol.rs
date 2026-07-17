use std::collections::{BTreeMap, VecDeque};

use fishbowl_contracts::{DaemonOperation, ErrorCode, RequestEnvelope, Validate};
use serde_json::{Value, json};

const UNKNOWN_REQUEST_ID: &str = "unknown";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl ProtocolError {
    pub const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[derive(Debug, Clone)]
struct ReplayEntry {
    request: String,
    response: String,
}

/// Bounded state for one persistent daemon transport connection.
///
/// Request IDs are replayed only when the canonical request bytes match. A
/// reused ID with different content is rejected instead of returning an
/// unrelated cached result.
pub struct ProtocolSession {
    capacity: usize,
    recent: BTreeMap<String, ReplayEntry>,
    order: VecDeque<String>,
}

impl ProtocolSession {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            recent: BTreeMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn handle_line<F>(&mut self, line: &str, mut dispatch: F) -> String
    where
        F: FnMut(&DaemonOperation) -> Result<Value, ProtocolError>,
    {
        let request_id = safe_request_id(line).unwrap_or_else(|| UNKNOWN_REQUEST_ID.to_owned());
        let request = match serde_json::from_str::<RequestEnvelope>(line) {
            Ok(value) => value,
            Err(_) => {
                return failure(
                    &request_id,
                    ErrorCode::InvalidRequest,
                    "Request shape or operation is invalid",
                );
            }
        };
        if let Err(code) = request.validate() {
            return failure(&request.request_id, code, validation_message(code));
        }
        let canonical = match serde_json::to_string(&request) {
            Ok(value) => value,
            Err(_) => {
                return failure(
                    &request.request_id,
                    ErrorCode::InternalError,
                    "Unexpected service failure",
                );
            }
        };
        if let Some(replay) = self.recent.get(&request.request_id) {
            if replay.request == canonical {
                return replay.response.clone();
            }
            return failure(
                &request.request_id,
                ErrorCode::OperationConflict,
                "Request ID was already used for different input",
            );
        }
        let response = match dispatch(&request.operation) {
            Ok(result) => serde_json::to_string(&json!({
                "ok": true,
                "requestId": request.request_id,
                "result": result,
            }))
            .unwrap_or_else(|_| {
                failure(
                    UNKNOWN_REQUEST_ID,
                    ErrorCode::InternalError,
                    "Unexpected service failure",
                )
            }),
            Err(error) => failure(&request.request_id, error.code, error.message),
        };
        self.remember(request.request_id, canonical, response.clone());
        response
    }

    fn remember(&mut self, request_id: String, request: String, response: String) {
        self.order.push_back(request_id.clone());
        self.recent
            .insert(request_id, ReplayEntry { request, response });
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.recent.remove(&oldest);
            }
        }
    }
}

fn safe_request_id(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let request_id = value.get("requestId")?.as_str()?;
    if request_id.is_empty() || request_id.len() > 200 {
        None
    } else {
        Some(request_id.to_owned())
    }
}

fn failure(request_id: &str, code: ErrorCode, message: &'static str) -> String {
    serde_json::to_string(&json!({
        "ok": false,
        "requestId": request_id,
        "error": { "code": code, "message": message },
    }))
    .expect("static failure envelope serializes")
}

fn validation_message(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::ProtocolMismatch => {
            "Daemon protocol version is incompatible; reinstall or restart Fishbowl"
        }
        ErrorCode::InvalidArgument => "Request argument is invalid",
        ErrorCode::PayloadTooLarge => "Request exceeds bounded contract limits",
        _ => "Request shape or operation is invalid",
    }
}
