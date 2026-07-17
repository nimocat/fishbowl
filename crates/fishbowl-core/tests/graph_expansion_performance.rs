use std::time::Instant;

use fishbowl_contracts::{NodeStatus, NodeType, RelationType};
use fishbowl_core::{ExpansionConfig, ExpansionEdge, ExpansionNode, expand_bounded};

#[test]
fn ten_thousand_node_bounded_expansion_has_bounded_release_latency() {
    let nodes = (0..10_000)
        .map(|index| ExpansionNode {
            project_id: "p1".into(),
            node_id: format!("n{index:05}"),
            node_type: NodeType::Problem,
            status: NodeStatus::Candidate,
            exact_score: u32::from(index == 0),
            semantic_score: None,
        })
        .collect::<Vec<_>>();
    let edges = (1..10_000)
        .map(|index| ExpansionEdge {
            source_id: format!("n{:05}", index - 1),
            relation: RelationType::Causes,
            target_id: format!("n{index:05}"),
        })
        .collect::<Vec<_>>();
    let config = ExpansionConfig {
        max_nodes: 256,
        max_edges: 512,
        max_iterations: 20,
        ..ExpansionConfig::default()
    };
    let mut samples = Vec::new();
    for _ in 0..100 {
        let started = Instant::now();
        let result =
            expand_bounded("p1", &["n00000".into()], &nodes, &edges, config).expect("expand");
        samples.push(started.elapsed().as_micros());
        assert!(result.metrics.visited_nodes <= 256);
        assert!(result.metrics.visited_edges <= 512);
    }
    samples.sort_unstable();
    let p95 = samples[94];
    println!("EKG_GRAPH_10K bounded_p95_us={p95}");
    if !cfg!(debug_assertions) {
        assert!(p95 < 50_000, "release p95 must stay below 50ms");
    }
}
