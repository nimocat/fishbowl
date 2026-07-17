use fishbowl_contracts::{NodeStatus, NodeType, RelationType};
use fishbowl_core::{
    ExpansionConfig, ExpansionEdge, ExpansionNode, HierarchyEdge, HierarchyRecord,
    KnowledgeHierarchy, expand_bounded,
};

#[test]
fn hierarchy_global_ndcg_exceeds_flat_case_text_for_structural_conclusions() {
    let records = vec![
        record(
            "case-camera",
            "ios",
            "preview symptom",
            "session queue binding",
        ),
        record("case-audio", "media", "decode delay", "packet pipeline"),
        record("case-model", "ml", "inference fallback", "compute units"),
    ];
    let hierarchy = KnowledgeHierarchy::build(
        1,
        records.clone(),
        vec![HierarchyEdge::new("case-camera", "case-camera")],
    );
    let queries = [
        ("session queue", "case-camera"),
        ("packet pipeline", "case-audio"),
        ("compute units", "case-model"),
    ];
    let mut hierarchy_dcg = 0.0;
    let mut flat_dcg = 0.0;
    for (query, expected) in queries {
        let hierarchy_hits = hierarchy.query_global("p1", query, 5);
        hierarchy_dcg += reciprocal_discount(
            hierarchy_hits
                .iter()
                .position(|hit| hit.supporting_case_ids.iter().any(|id| id == expected)),
        );
        let terms = query.split_whitespace().collect::<Vec<_>>();
        let mut flat = records
            .iter()
            .map(|record| {
                (
                    record.case_id.as_str(),
                    terms
                        .iter()
                        .filter(|term| record.text.contains(**term))
                        .count(),
                )
            })
            .filter(|(_, score)| *score > 0)
            .collect::<Vec<_>>();
        flat.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0)));
        flat_dcg += reciprocal_discount(flat.iter().position(|(id, _)| *id == expected));
    }
    let hierarchy_ndcg = hierarchy_dcg / queries.len() as f64;
    let flat_ndcg = flat_dcg / queries.len() as f64;
    assert_eq!(hierarchy_ndcg, 1.0);
    assert!(hierarchy_ndcg > flat_ndcg);
}

#[test]
fn bounded_graph_expansion_improves_multihop_recall_at_five() {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for index in 0..10 {
        nodes.extend([
            expansion_node(
                &format!("problem-{index}"),
                NodeType::Problem,
                NodeStatus::Open,
                1,
            ),
            expansion_node(
                &format!("root-{index}"),
                NodeType::RootCause,
                NodeStatus::Verified,
                0,
            ),
            expansion_node(
                &format!("solution-{index}"),
                NodeType::Solution,
                NodeStatus::Verified,
                0,
            ),
        ]);
        edges.extend([
            ExpansionEdge {
                source_id: format!("root-{index}"),
                relation: RelationType::Causes,
                target_id: format!("problem-{index}"),
            },
            ExpansionEdge {
                source_id: format!("solution-{index}"),
                relation: RelationType::Addresses,
                target_id: format!("root-{index}"),
            },
        ]);
    }
    let mut expanded_hits = 0;
    let flat_hits = 0;
    for index in 0..10 {
        let result = expand_bounded(
            "p1",
            &[format!("problem-{index}")],
            &nodes,
            &edges,
            ExpansionConfig::default(),
        )
        .expect("expand");
        if result
            .hits
            .iter()
            .take(5)
            .any(|hit| hit.node_id == format!("solution-{index}"))
        {
            expanded_hits += 1;
        }
    }
    assert_eq!(expanded_hits, 10);
    assert!(expanded_hits > flat_hits);
}

fn reciprocal_discount(position: Option<usize>) -> f64 {
    position.map_or(0.0, |index| 1.0 / ((index + 2) as f64).log2())
}

fn record(case_id: &str, domain: &str, text: &str, conclusion: &str) -> HierarchyRecord {
    HierarchyRecord {
        project_id: "p1".into(),
        domain: domain.into(),
        case_id: case_id.into(),
        status: NodeStatus::Verified,
        text: text.into(),
        fingerprints: Vec::new(),
        files: Vec::new(),
        commands: Vec::new(),
        verified_conclusion: Some(conclusion.into()),
    }
}

fn expansion_node(
    node_id: &str,
    node_type: NodeType,
    status: NodeStatus,
    exact_score: u32,
) -> ExpansionNode {
    ExpansionNode {
        project_id: "p1".into(),
        node_id: node_id.into(),
        node_type,
        status,
        exact_score,
        semantic_score: None,
    }
}
