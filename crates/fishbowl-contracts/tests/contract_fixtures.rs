use std::fs;
use std::path::PathBuf;

use fishbowl_contracts::{
    CheckpointWorkResult, DiskObservationSummary, ErrorCode, FailureEnvelope, FinalizeWorkResult,
    GetCaseResult, NodeStatus, PreflightResult, PromotionStatus, QueryKnowledgeResult,
    RequestEnvelope, SuccessEnvelope, Validate,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/contracts")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).expect("fixture file")).expect("fixture JSON")
}

fn decode<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).expect("fixture matches Rust contract")
}

#[test]
fn read_contract_fixtures_round_trip_canonically() {
    for (file, decode_result) in [
        ("query_knowledge.json", decode_query as fn(&Value)),
        ("preflight.json", decode_preflight as fn(&Value)),
        ("get_case.json", decode_get_case as fn(&Value)),
    ] {
        let value = fixture(file);
        let request: RequestEnvelope = decode(&value["request"]);
        request.validate().expect("bounded request");
        assert_eq!(serde_json::to_value(&request).unwrap(), value["request"]);
        decode_result(&value["response"]);
    }
}

fn decode_query(value: &Value) {
    let response: SuccessEnvelope<QueryKnowledgeResult> = decode(value);
    response.validate().unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), *value);
}

fn decode_preflight(value: &Value) {
    let response: SuccessEnvelope<PreflightResult> = decode(value);
    response.validate().unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), *value);
}

fn decode_get_case(value: &Value) {
    let response: SuccessEnvelope<GetCaseResult> = decode(value);
    response.validate().unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), *value);
}

#[test]
fn invalid_contracts_are_rejected_without_echoing_inputs() {
    let cases = fixture("errors.json");
    for item in cases.as_array().unwrap() {
        let parsed = serde_json::from_value::<RequestEnvelope>(item["request"].clone());
        let actual = match parsed {
            Ok(request) => request.validate().unwrap_err(),
            Err(_) => ErrorCode::InvalidRequest,
        };
        assert_eq!(serde_json::to_value(actual).unwrap(), item["expectedCode"]);
    }

    let failure: FailureEnvelope = decode(&serde_json::json!({
        "ok": false,
        "requestId": "request-safe",
        "error": {"code": "INVALID_ARGUMENT", "message": "Project reference is invalid"}
    }));
    let encoded = serde_json::to_string(&failure).unwrap();
    assert!(!encoded.contains("secret-input"));
}

#[test]
fn unknown_nested_fields_are_rejected() {
    let mut request = fixture("query_knowledge.json")["request"].clone();
    request["input"]["project"]["unexpected"] = Value::Bool(true);
    assert!(serde_json::from_value::<RequestEnvelope>(request).is_err());
}

#[test]
fn output_serialization_is_deterministic() {
    let value = fixture("query_knowledge.json");
    let response: SuccessEnvelope<QueryKnowledgeResult> = decode(&value["response"]);
    let expected = serde_json::to_string(&response).unwrap();
    for _ in 0..100 {
        assert_eq!(serde_json::to_string(&response).unwrap(), expected);
    }
}

#[test]
fn write_outputs_omit_absent_optional_fields() {
    let encoded = serde_json::to_value(CheckpointWorkResult {
        recorded: true,
        reason: None,
        created_case: true,
        case_id: Some("case-1".into()),
        problem_id: Some("problem-1".into()),
        attempt_id: Some("attempt-1".into()),
        root_cause_id: None,
        solution_id: None,
    })
    .unwrap();

    assert_eq!(
        encoded,
        serde_json::json!({
            "recorded": true,
            "createdCase": true,
            "caseId": "case-1",
            "problemId": "problem-1",
            "attemptId": "attempt-1"
        })
    );

    let finalized = serde_json::to_value(FinalizeWorkResult {
        recorded: true,
        created_case: true,
        case_id: "case-1".into(),
        problem_id: "problem-1".into(),
        attempt_ids: Vec::new(),
        root_cause_id: None,
        solution_id: None,
        verification_ids: Vec::new(),
        artifact_ids: Vec::new(),
        merge_recorded: true,
        promotion: PromotionStatus {
            status: NodeStatus::Candidate,
            missing_requirements: Vec::new(),
            next_actions: Vec::new(),
        },
    })
    .unwrap();
    assert!(!finalized.as_object().unwrap().contains_key("rootCauseId"));
    assert!(!finalized.as_object().unwrap().contains_key("solutionId"));
}

#[test]
fn retrieval_explanations_and_diagnostics_enforce_p0_budgets() {
    let mut oversized_diagnostics = fixture("query_knowledge.json")["response"].clone();
    oversized_diagnostics["result"]["diagnostics"] = serde_json::json!({
        "mode": "hybrid",
        "seedCount": 16,
        "candidateCaseCount": 65,
        "visitedNodes": 256,
        "visitedEdges": 1024,
        "iterations": 20
    });
    let response: SuccessEnvelope<QueryKnowledgeResult> = decode(&oversized_diagnostics);
    assert_eq!(response.validate(), Err(ErrorCode::PayloadTooLarge));

    let mut oversized_reason = fixture("query_knowledge.json")["response"].clone();
    oversized_reason["result"]["items"][0]["whyMatched"] = serde_json::json!([{
        "kind": "prefix-route",
        "value": "x".repeat(257)
    }]);
    let response: SuccessEnvelope<QueryKnowledgeResult> = decode(&oversized_reason);
    assert_eq!(response.validate(), Err(ErrorCode::PayloadTooLarge));
}

#[test]
fn disk_observation_contracts_are_strict_bounded_and_canonical() {
    let value = serde_json::json!({
        "protocolVersion": 2,
        "requestId": "disk-start-1",
        "operation": "startDiskObservation",
        "input": {
            "project": {"projectId": "project-alpha"},
            "operationId": "disk-operation-1",
            "task": "bounded disk attribution"
        }
    });
    let request: RequestEnvelope = decode(&value);
    request.validate().unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);

    let oversized = serde_json::json!({
        "protocolVersion": 2,
        "requestId": "disk-list-1",
        "operation": "listCleanupCandidates",
        "input": {"project": {"projectId": "project-alpha"}, "limit": 101}
    });
    let request: RequestEnvelope = decode(&oversized);
    assert_eq!(request.validate(), Err(ErrorCode::PayloadTooLarge));

    let mut unknown = value;
    unknown["input"]["absolutePaths"] = Value::Bool(true);
    assert!(serde_json::from_value::<RequestEnvelope>(unknown).is_err());

    let running = DiskObservationSummary {
        observation_id: "obs-running".into(),
        task: "build".into(),
        status: "running".into(),
        started_at: "2026-07-18T00:00:00Z".into(),
        finished_at: None,
        baseline_tracked_bytes: 10,
        final_tracked_bytes: None,
        delta_bytes: None,
        positive_growth_bytes: None,
        overlapping_observations: 0,
        scan_truncated: false,
    };
    let serialized = serde_json::to_value(running).unwrap();
    for field in [
        "finishedAt",
        "finalTrackedBytes",
        "deltaBytes",
        "positiveGrowthBytes",
    ] {
        assert!(
            serialized.get(field).is_none(),
            "{field} should be omitted when unknown"
        );
    }
}
