use fishbowl_contracts::{NodeStatus, NodeType, RelationType};
use fishbowl_core::{
    ExpansionConfig, ExpansionEdge, ExpansionNode, ExpansionTermination, expand_bounded,
};

fn node(
    project: &str,
    id: &str,
    node_type: NodeType,
    status: NodeStatus,
    exact_score: u32,
    semantic_score: Option<u16>,
) -> ExpansionNode {
    ExpansionNode {
        project_id: project.into(),
        node_id: id.into(),
        node_type,
        status,
        exact_score,
        semantic_score,
    }
}

fn edge(source: &str, relation: RelationType, target: &str) -> ExpansionEdge {
    ExpansionEdge {
        source_id: source.into(),
        relation,
        target_id: target.into(),
    }
}

fn causal_graph() -> (Vec<ExpansionNode>, Vec<ExpansionEdge>) {
    (
        vec![
            node(
                "p1",
                "problem",
                NodeType::Problem,
                NodeStatus::Open,
                1,
                None,
            ),
            node(
                "p1",
                "attempt",
                NodeType::Attempt,
                NodeStatus::Candidate,
                0,
                None,
            ),
            node(
                "p1",
                "root",
                NodeType::RootCause,
                NodeStatus::Verified,
                0,
                None,
            ),
            node(
                "p1",
                "solution",
                NodeType::Solution,
                NodeStatus::Verified,
                0,
                None,
            ),
            node(
                "p2",
                "foreign",
                NodeType::Solution,
                NodeStatus::Verified,
                100,
                Some(1000),
            ),
        ],
        vec![
            edge("attempt", RelationType::AttemptsToSolve, "problem"),
            edge("attempt", RelationType::FailedBecause, "root"),
            edge("root", RelationType::Causes, "problem"),
            edge("solution", RelationType::Addresses, "root"),
            edge("foreign", RelationType::Addresses, "root"),
        ],
    )
}

#[test]
fn bounded_ppr_recovers_root_cause_and_solution_paths_without_crossing_projects() {
    let (nodes, edges) = causal_graph();
    let result = expand_bounded(
        "p1",
        &["problem".into()],
        &nodes,
        &edges,
        ExpansionConfig::default(),
    )
    .expect("expand graph");

    let ids = result
        .hits
        .iter()
        .take(5)
        .map(|hit| hit.node_id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"root"));
    assert!(ids.contains(&"solution"));
    assert!(!ids.contains(&"foreign"));
    assert_eq!(
        result
            .hits
            .iter()
            .find(|hit| hit.node_id == "solution")
            .expect("solution")
            .supporting_path,
        vec!["problem", "root", "solution"]
    );
}

#[test]
fn dense_graph_stops_at_explicit_node_edge_and_iteration_budgets() {
    let nodes = (0..200)
        .map(|index| {
            node(
                "p1",
                &format!("n{index:03}"),
                NodeType::Problem,
                NodeStatus::Open,
                0,
                None,
            )
        })
        .collect::<Vec<_>>();
    let mut edges = Vec::new();
    for left in 0..200 {
        for right in (left + 1)..200 {
            edges.push(edge(
                &format!("n{left:03}"),
                RelationType::References,
                &format!("n{right:03}"),
            ));
        }
    }
    let config = ExpansionConfig {
        max_nodes: 32,
        max_edges: 64,
        max_iterations: 7,
        ..ExpansionConfig::default()
    };
    let result =
        expand_bounded("p1", &["n000".into()], &nodes, &edges, config).expect("bounded expansion");

    assert!(result.metrics.visited_nodes <= 32);
    assert!(result.metrics.visited_edges <= 64);
    assert!(result.metrics.iterations <= 7);
    assert_eq!(
        result.metrics.termination,
        ExpansionTermination::BudgetReached
    );
}

#[test]
fn semantic_similarity_cannot_outrank_an_exact_verified_match() {
    let nodes = vec![
        node(
            "p1",
            "exact",
            NodeType::Solution,
            NodeStatus::Verified,
            1,
            None,
        ),
        node(
            "p1",
            "semantic",
            NodeType::Solution,
            NodeStatus::Verified,
            0,
            Some(1000),
        ),
    ];
    let result = expand_bounded(
        "p1",
        &["exact".into(), "semantic".into()],
        &nodes,
        &[],
        ExpansionConfig {
            semantic_enabled: true,
            ..ExpansionConfig::default()
        },
    )
    .expect("rank");

    assert_eq!(result.hits[0].node_id, "exact");
    assert!(result.hits[0].score_micros > result.hits[1].score_micros);
}

#[test]
fn disabling_semantic_recall_is_deterministic_and_complete() {
    let (nodes, edges) = causal_graph();
    let config = ExpansionConfig {
        semantic_enabled: false,
        ..ExpansionConfig::default()
    };
    let first = expand_bounded("p1", &["problem".into()], &nodes, &edges, config).expect("first");
    let second = expand_bounded("p1", &["problem".into()], &nodes, &edges, config).expect("second");

    assert_eq!(first, second);
    assert_eq!(first.hits.len(), 4);
    assert!(first.hits.iter().all(|hit| hit.semantic_score == 0));
}
