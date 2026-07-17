use std::collections::{BTreeMap, BTreeSet, VecDeque};

use fishbowl_contracts::{NodeStatus, NodeType, RelationType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpansionConfig {
    pub max_nodes: usize,
    pub max_edges: usize,
    pub max_iterations: usize,
    pub damping_milli: u16,
    pub semantic_enabled: bool,
}

impl Default for ExpansionConfig {
    fn default() -> Self {
        Self {
            max_nodes: 256,
            max_edges: 1024,
            max_iterations: 20,
            damping_milli: 850,
            semantic_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpansionNode {
    pub project_id: String,
    pub node_id: String,
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub exact_score: u32,
    /// Optional caller-owned similarity in the inclusive range 0...1000.
    pub semantic_score: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpansionEdge {
    pub source_id: String,
    pub relation: RelationType,
    pub target_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExpansionTermination {
    Converged,
    IterationLimit,
    BudgetReached,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpansionMetrics {
    pub visited_nodes: usize,
    pub visited_edges: usize,
    pub iterations: usize,
    pub termination: ExpansionTermination,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpansionHit {
    pub node_id: String,
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub score_micros: u64,
    pub graph_score_micros: u64,
    pub exact_score: u32,
    pub semantic_score: u16,
    pub supporting_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpansionResult {
    pub hits: Vec<ExpansionHit>,
    pub metrics: ExpansionMetrics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpansionError {
    InvalidBudget,
    MissingSeed,
}

/// Runs deterministic, project-local, budgeted personalized PageRank.
///
/// Edges are traversed in both directions because the causal graph stores
/// relations according to domain semantics rather than query direction. Exact
/// evidence is scored in a separate dominant tier; optional similarity can
/// refine ties but cannot displace an exact match by itself.
pub fn expand_bounded(
    project_id: &str,
    seeds: &[String],
    nodes: &[ExpansionNode],
    edges: &[ExpansionEdge],
    config: ExpansionConfig,
) -> Result<ExpansionResult, ExpansionError> {
    if config.max_nodes == 0
        || config.max_edges == 0
        || config.max_iterations == 0
        || !(1..1000).contains(&config.damping_milli)
    {
        return Err(ExpansionError::InvalidBudget);
    }

    let project_nodes = nodes
        .iter()
        .filter(|node| node.project_id == project_id)
        .map(|node| (node.node_id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let seed_set = seeds
        .iter()
        .filter(|seed| project_nodes.contains_key(*seed))
        .cloned()
        .collect::<BTreeSet<_>>();
    if seed_set.is_empty() {
        return Err(ExpansionError::MissingSeed);
    }

    let mut candidate_adjacency = BTreeMap::<String, Vec<(String, u32)>>::new();
    for edge in edges {
        if !project_nodes.contains_key(&edge.source_id)
            || !project_nodes.contains_key(&edge.target_id)
        {
            continue;
        }
        let weight = relation_weight(&edge.relation);
        candidate_adjacency
            .entry(edge.source_id.clone())
            .or_default()
            .push((edge.target_id.clone(), weight));
        candidate_adjacency
            .entry(edge.target_id.clone())
            .or_default()
            .push((edge.source_id.clone(), weight));
    }
    for neighbors in candidate_adjacency.values_mut() {
        neighbors.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1)));
        neighbors.dedup_by(|left, right| left.0 == right.0);
    }

    let mut selected = seed_set.clone();
    let mut queue = seed_set.iter().cloned().collect::<VecDeque<_>>();
    let mut parents = BTreeMap::<String, String>::new();
    let mut selected_edges = BTreeMap::<(String, String), u32>::new();
    let mut budget_reached = selected.len() > config.max_nodes;
    while let Some(current) = queue.pop_front() {
        for (neighbor, base_weight) in candidate_adjacency.get(&current).into_iter().flatten() {
            if selected_edges.len() >= config.max_edges {
                budget_reached = true;
                break;
            }
            if !selected.contains(neighbor) && selected.len() >= config.max_nodes {
                budget_reached = true;
                continue;
            }
            if selected.insert(neighbor.clone()) {
                parents.insert(neighbor.clone(), current.clone());
                queue.push_back(neighbor.clone());
            }
            if selected.contains(neighbor) {
                let key = ordered_pair(&current, neighbor);
                let trust = trust_weight(project_nodes[&current], project_nodes[neighbor]);
                selected_edges.entry(key).or_insert(*base_weight + trust);
            }
        }
        if selected_edges.len() >= config.max_edges {
            break;
        }
    }

    let mut adjacency = selected
        .iter()
        .map(|node_id| (node_id.clone(), Vec::<(String, u32)>::new()))
        .collect::<BTreeMap<_, _>>();
    for ((left, right), weight) in &selected_edges {
        adjacency
            .get_mut(left)
            .expect("selected edge source")
            .push((right.clone(), *weight));
        adjacency
            .get_mut(right)
            .expect("selected edge target")
            .push((left.clone(), *weight));
    }
    for neighbors in adjacency.values_mut() {
        neighbors.sort_by(|left, right| left.0.cmp(&right.0));
    }

    let personalization = 1.0 / seed_set.len() as f64;
    let damping = f64::from(config.damping_milli) / 1000.0;
    let mut ranks = selected
        .iter()
        .map(|node_id| {
            (
                node_id.clone(),
                if seed_set.contains(node_id) {
                    personalization
                } else {
                    0.0
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut iterations = 0;
    let mut converged = false;
    for iteration in 0..config.max_iterations {
        iterations = iteration + 1;
        let mut next = selected
            .iter()
            .map(|node_id| {
                (
                    node_id.clone(),
                    if seed_set.contains(node_id) {
                        (1.0 - damping) * personalization
                    } else {
                        0.0
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        for (node_id, rank) in &ranks {
            let neighbors = &adjacency[node_id];
            let total_weight = neighbors
                .iter()
                .map(|(_, weight)| *weight as u64)
                .sum::<u64>();
            if total_weight == 0 {
                for seed in &seed_set {
                    *next.get_mut(seed).expect("seed") += damping * rank * personalization;
                }
                continue;
            }
            for (neighbor, weight) in neighbors {
                *next.get_mut(neighbor).expect("neighbor") +=
                    damping * rank * f64::from(*weight) / total_weight as f64;
            }
        }
        let delta = selected
            .iter()
            .map(|node_id| (next[node_id] - ranks[node_id]).abs())
            .sum::<f64>();
        ranks = next;
        if delta < 0.000_001 {
            converged = true;
            break;
        }
    }

    let mut hits = selected
        .iter()
        .map(|node_id| {
            let node = project_nodes[node_id];
            let graph_score_micros = (ranks[node_id] * 500_000.0).round() as u64;
            let semantic_score = if config.semantic_enabled {
                node.semantic_score.unwrap_or(0).min(1000)
            } else {
                0
            };
            let trust_score = match node.status {
                NodeStatus::Verified => 100_000,
                NodeStatus::Regressed | NodeStatus::Retired => 0,
                NodeStatus::Open | NodeStatus::Candidate => 20_000,
            };
            ExpansionHit {
                node_id: node_id.clone(),
                node_type: node.node_type,
                status: node.status,
                score_micros: u64::from(node.exact_score) * 1_000_000
                    + graph_score_micros
                    + trust_score
                    + u64::from(semantic_score) * 100,
                graph_score_micros,
                exact_score: node.exact_score,
                semantic_score,
                supporting_path: supporting_path(node_id, &seed_set, &parents),
            }
        })
        .collect::<Vec<_>>();
    hits.sort_by(|left, right| {
        right
            .score_micros
            .cmp(&left.score_micros)
            .then_with(|| right.exact_score.cmp(&left.exact_score))
            .then_with(|| left.node_id.cmp(&right.node_id))
    });

    Ok(ExpansionResult {
        hits,
        metrics: ExpansionMetrics {
            visited_nodes: selected.len(),
            visited_edges: selected_edges.len(),
            iterations,
            termination: if budget_reached {
                ExpansionTermination::BudgetReached
            } else if converged {
                ExpansionTermination::Converged
            } else {
                ExpansionTermination::IterationLimit
            },
        },
    })
}

fn relation_weight(relation: &RelationType) -> u32 {
    match relation {
        RelationType::FailedBecause | RelationType::Causes | RelationType::Addresses => 1200,
        RelationType::VerifiedBy => 1100,
        RelationType::Prevents => 1050,
        RelationType::AttemptsToSolve | RelationType::Supersedes => 900,
        RelationType::Includes => 800,
        RelationType::References => 600,
        RelationType::PrecededBy => 500,
    }
}

fn trust_weight(left: &ExpansionNode, right: &ExpansionNode) -> u32 {
    [left.status, right.status]
        .into_iter()
        .map(|status| match status {
            NodeStatus::Verified => 200,
            NodeStatus::Open | NodeStatus::Candidate => 50,
            NodeStatus::Regressed | NodeStatus::Retired => 0,
        })
        .sum()
}

fn ordered_pair(left: &str, right: &str) -> (String, String) {
    if left <= right {
        (left.into(), right.into())
    } else {
        (right.into(), left.into())
    }
}

fn supporting_path(
    node_id: &str,
    seeds: &BTreeSet<String>,
    parents: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut path = vec![node_id.to_owned()];
    let mut current = node_id;
    let mut seen = BTreeSet::new();
    while !seeds.contains(current) && seen.insert(current.to_owned()) {
        let Some(parent) = parents.get(current) else {
            break;
        };
        path.push(parent.clone());
        current = parent;
    }
    path.reverse();
    path
}
