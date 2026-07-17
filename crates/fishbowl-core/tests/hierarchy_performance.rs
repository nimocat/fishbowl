use std::time::Instant;

use fishbowl_contracts::NodeStatus;
use fishbowl_core::{HierarchyEdge, HierarchyRecord, KnowledgeHierarchy};

#[test]
fn ten_thousand_case_hierarchy_build_and_incremental_rebuild_are_bounded() {
    let mut records = Vec::with_capacity(10_000);
    let mut edges = Vec::with_capacity(9_990);
    for number in 0..10_000 {
        let domain = format!("domain-{}", number % 10);
        let case_id = format!("case-{number:05}");
        records.push(record(&domain, &case_id, number));
        if number >= 10 {
            edges.push(HierarchyEdge::new(
                &format!("case-{:05}", number - 10),
                &case_id,
            ));
        }
    }
    let started = Instant::now();
    let mut hierarchy = KnowledgeHierarchy::build(1, records, edges);
    let build_ms = started.elapsed().as_secs_f64() * 1000.0;
    let before = hierarchy.branch_json("project-a", "domain-1").unwrap();
    let started = Instant::now();
    hierarchy.upsert(2, record("domain-0", "case-00000", 99_999));
    let incremental_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(
        hierarchy.last_rebuilt_branches(),
        &[("project-a".into(), "domain-0".into())]
    );
    assert_eq!(
        hierarchy.branch_json("project-a", "domain-1").unwrap(),
        before
    );
    eprintln!("EKG_HIERARCHY_10K build_ms={build_ms:.3} incremental_ms={incremental_ms:.3}");
    let build_budget = if cfg!(debug_assertions) {
        5000.0
    } else {
        1000.0
    };
    let incremental_budget = if cfg!(debug_assertions) { 500.0 } else { 50.0 };
    assert!(build_ms < build_budget);
    assert!(incremental_ms < incremental_budget);
}

fn record(domain: &str, case_id: &str, number: usize) -> HierarchyRecord {
    HierarchyRecord {
        project_id: "project-a".into(),
        domain: domain.into(),
        case_id: case_id.into(),
        status: NodeStatus::Candidate,
        text: format!("engineering knowledge {number}"),
        fingerprints: vec![],
        files: vec![],
        commands: vec![],
        verified_conclusion: None,
    }
}
