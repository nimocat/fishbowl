use std::cell::Cell;
use std::time::Instant;

use ekg_daemon::protocol::{ProtocolError, ProtocolSession};
use serde_json::{Value, json};

#[test]
fn persistent_protocol_replays_request_ids_without_redispatch() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/query_knowledge.json"
    ))
    .unwrap();
    let line = serde_json::to_string(&fixture["request"]).unwrap();
    let calls = Cell::new(0);
    let mut session = ProtocolSession::new(128);
    let first = session.handle_line(&line, |_| {
        calls.set(calls.get() + 1);
        Ok(fixture["response"]["result"].clone())
    });
    let second = session.handle_line(&line, |_| -> Result<Value, ProtocolError> {
        panic!("replayed request must not dispatch")
    });
    assert_eq!(first, second);
    assert_eq!(calls.get(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&first).unwrap(),
        fixture["response"]
    );
}

#[test]
fn protocol_failures_are_stable_bounded_and_actionable() {
    let mut session = ProtocolSession::new(8);
    let mismatch = session.handle_line(
        r#"{"protocolVersion":999,"requestId":"mismatch-1","operation":"queryKnowledge","input":{"project":{"projectId":"alpha"}}}"#,
        |_| Ok(json!({})),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&mismatch).unwrap(),
        json!({
            "ok": false,
            "requestId": "mismatch-1",
            "error": {
                "code": "PROTOCOL_MISMATCH",
                "message": "Daemon protocol version is incompatible; reinstall or restart EKG"
            }
        })
    );
    let hostile = session.handle_line(
        r#"{"protocolVersion":1,"requestId":"bad-1","operation":"readArbitraryFile","input":{"secret":"do-not-echo"}}"#,
        |_| Ok(json!({})),
    );
    assert!(!hostile.contains("do-not-echo"));
    assert!(hostile.contains("INVALID_REQUEST"));

    let first = r#"{"protocolVersion":1,"requestId":"reused-1","operation":"queryKnowledge","input":{"project":{"projectId":"alpha"},"text":"first"}}"#;
    let changed = r#"{"protocolVersion":1,"requestId":"reused-1","operation":"queryKnowledge","input":{"project":{"projectId":"alpha"},"text":"changed-secret"}}"#;
    session.handle_line(first, |_| Ok(json!({"items": []})));
    let conflict = session.handle_line(changed, |_| panic!("conflicting replay must not dispatch"));
    assert!(conflict.contains("OPERATION_CONFLICT"));
    assert!(!conflict.contains("changed-secret"));
}

#[test]
fn replay_latency_is_bounded_excluding_process_startup() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/query_knowledge.json"
    ))
    .unwrap();
    let line = serde_json::to_string(&fixture["request"]).unwrap();
    let mut session = ProtocolSession::new(128);
    session.handle_line(&line, |_| Ok(fixture["response"]["result"].clone()));
    let mut micros = Vec::with_capacity(1000);
    for _ in 0..1000 {
        let started = Instant::now();
        session.handle_line(&line, |_| panic!("must replay"));
        micros.push(started.elapsed().as_micros());
    }
    micros.sort_unstable();
    let p95 = micros[949];
    eprintln!("EKG_RUST_PROTOCOL_REPLAY p95_us={p95}");
    assert!(p95 < 10_000);
}
