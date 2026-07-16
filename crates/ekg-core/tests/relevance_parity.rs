use std::collections::BTreeMap;

use ekg_contracts::{NodeRecord, NodeStatus, NodeType, PreflightGuardrail, PreflightResult};
use ekg_core::{RelevanceCandidate, RelevanceContext, compact_preflight, rank_cases};
use serde_json::{Value, json};

#[test]
fn exact_and_trusted_reasons_outrank_common_lexical_terms() {
    let exact = RelevanceCandidate {
        case_id: "case-exact".into(),
        case_title: "Specific file".into(),
        case_status: NodeStatus::Candidate,
        nodes: vec![node(
            "exact-node",
            NodeType::Problem,
            NodeStatus::Open,
            json!({"file":"Sources/CameraView.swift"}),
        )],
        guardrails: vec![],
    };
    let verified = RelevanceCandidate {
        case_id: "case-verified".into(),
        case_title: "Build test fix".into(),
        case_status: NodeStatus::Verified,
        nodes: vec![node(
            "verified-node",
            NodeType::Solution,
            NodeStatus::Verified,
            json!({"summary":"build test fix"}),
        )],
        guardrails: vec![],
    };
    let common = RelevanceCandidate {
        case_id: "case-common".into(),
        case_title: "build test fix".into(),
        case_status: NodeStatus::Candidate,
        nodes: vec![node(
            "common-node",
            NodeType::Problem,
            NodeStatus::Open,
            json!({"summary":"build test fix"}),
        )],
        guardrails: vec![],
    };
    let ranked = rank_cases(
        &RelevanceContext {
            task_description: "build test fix".into(),
            changed_files: vec!["Sources/CameraView.swift".into()],
            command: vec![],
            fingerprint_case_ids: vec![],
            now_epoch_ms: 1_752_624_000_000,
        },
        vec![common, verified, exact],
    );
    assert_eq!(ranked[0].case_id, "case-exact");
    assert_eq!(
        ranked[0].why_matched[0].kind,
        ekg_contracts::MatchKind::ExactFile
    );
    assert!(ranked.iter().any(|card| card.case_id == "case-verified"));
    assert!(!ranked.iter().any(|card| card.case_id == "case-common"));
}

#[test]
fn fingerprint_and_blocking_reasons_are_explicit_and_deterministic() {
    let guardrail_node = node(
        "guardrail",
        NodeType::Guardrail,
        NodeStatus::Verified,
        json!({"guidance":"physical device only"}),
    );
    let candidate = RelevanceCandidate {
        case_id: "case-policy".into(),
        case_title: "Device policy".into(),
        case_status: NodeStatus::Verified,
        nodes: vec![guardrail_node.clone()],
        guardrails: vec![PreflightGuardrail {
            node: guardrail_node,
            blocks: true,
        }],
    };
    let context = RelevanceContext {
        task_description: "CoreML verification".into(),
        changed_files: vec![],
        command: vec![],
        fingerprint_case_ids: vec!["case-policy".into()],
        now_epoch_ms: 1_752_624_000_000,
    };
    let first = rank_cases(&context, vec![candidate.clone()]);
    let second = rank_cases(&context, vec![candidate]);
    assert_eq!(first, second);
    assert_eq!(first[0].score, 1900.0);
    assert_eq!(
        first[0]
            .why_matched
            .iter()
            .map(|reason| reason.kind.clone())
            .collect::<Vec<_>>(),
        vec![
            ekg_contracts::MatchKind::ExactFingerprint,
            ekg_contracts::MatchKind::BlockingGuardrail,
        ]
    );
}

#[test]
fn compact_preflight_stays_bounded_and_preserves_expansion_ids() {
    let cards = (0..10)
        .map(|index| ekg_contracts::PreflightCard {
            case_id: format!("case-{index}"),
            case_title: "x".repeat(500),
            score: 100.0 - index as f64,
            why_matched: vec![ekg_contracts::MatchReason {
                kind: ekg_contracts::MatchKind::Text,
                value: "x".repeat(500),
            }],
            failed_attempt: None,
            root_cause: None,
            solution: None,
            guardrails: None,
        })
        .collect();
    let result = compact_preflight(
        PreflightResult {
            blocked: false,
            cards,
            guardrails: vec![],
            failed_attempts: vec![],
            root_causes: vec![],
            solutions: vec![],
            uncertain: vec![],
            truncated: false,
            expansion_case_ids: vec![],
        },
        12 * 1024,
    );
    assert!(result.cards.len() <= 5);
    assert!(serde_json::to_vec(&result).unwrap().len() < 12 * 1024);
    assert!(result.truncated);
    assert!(!result.expansion_case_ids.is_empty());
}

#[test]
fn stale_candidate_penalties_match_the_compatibility_policy() {
    let mut fresh_node = node(
        "fresh",
        NodeType::Problem,
        NodeStatus::Candidate,
        json!({"summary":"specialterm"}),
    );
    fresh_node.case_id = "fresh-case".into();
    fresh_node.created_at = "2026-07-15T00:00:00Z".into();
    let mut old_node = node(
        "old",
        NodeType::Problem,
        NodeStatus::Candidate,
        json!({"summary":"specialterm"}),
    );
    old_node.case_id = "old-case".into();
    old_node.created_at = "2026-01-01T00:00:00Z".into();
    let ranked = rank_cases(
        &RelevanceContext {
            task_description: "specialterm".into(),
            changed_files: vec![],
            command: vec![],
            fingerprint_case_ids: vec![],
            now_epoch_ms: 1_752_624_000_000 + 31_536_000_000,
        },
        vec![
            RelevanceCandidate {
                case_id: "old-case".into(),
                case_title: "Old".into(),
                case_status: NodeStatus::Candidate,
                nodes: vec![old_node],
                guardrails: vec![],
            },
            RelevanceCandidate {
                case_id: "fresh-case".into(),
                case_title: "Fresh".into(),
                case_status: NodeStatus::Candidate,
                nodes: vec![fresh_node],
                guardrails: vec![],
            },
        ],
    );
    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0].case_id, "fresh-case");
}

fn node(id: &str, node_type: NodeType, status: NodeStatus, data: Value) -> NodeRecord {
    NodeRecord {
        id: id.into(),
        case_id: "case".into(),
        node_type,
        status,
        data: data
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>(),
        created_at: "2026-07-16T00:00:00Z".into(),
    }
}
