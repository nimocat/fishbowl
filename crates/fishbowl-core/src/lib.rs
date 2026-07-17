//! Rust retrieval and policy core for Fishbowl.
//!
//! The first migration slice intentionally has no third-party dependencies. It
//! establishes deterministic Unicode routing and Guardrail semantics before
//! storage and graph traversal move across the daemon boundary.

use std::collections::{BTreeMap, BTreeSet};

use fishbowl_contracts::{
    MatchKind, MatchReason, NodeRecord, NodeStatus, NodeType, PreflightCard, PreflightGuardrail,
    PreflightResult,
};
use serde_json::Value;

mod graph_expansion;
mod hierarchy;
pub use graph_expansion::*;
pub use hierarchy::*;

pub type ApplicabilityBoundary = BTreeMap<String, Vec<String>>;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PromotionEvidence {
    pub root_cause_evidence_count: usize,
    pub root_cause_verified: bool,
    pub successful_automated_verification_count: usize,
    pub non_automatable_reason: Option<String>,
    pub human_verification_required: bool,
    pub human_verification_present: bool,
    pub human_confirmed: bool,
    pub applicability: Vec<String>,
    pub limitations: Vec<String>,
    pub decisive_difference: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionRequirement {
    RootCauseEvidence,
    VerifiedRootCause,
    AutomatedVerificationOrException,
    RequiredHumanVerification,
    HumanConfirmation,
    Applicability,
    Limitations,
    DecisiveDifference,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionEvaluation {
    pub eligible: bool,
    pub missing_requirements: Vec<PromotionRequirement>,
}

pub fn evaluate_promotion(input: &PromotionEvidence) -> PromotionEvaluation {
    let mut missing = Vec::new();
    if input.root_cause_evidence_count < 1 {
        missing.push(PromotionRequirement::RootCauseEvidence);
    }
    if !input.root_cause_verified {
        missing.push(PromotionRequirement::VerifiedRootCause);
    }
    if input.successful_automated_verification_count < 1
        && input
            .non_automatable_reason
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        missing.push(PromotionRequirement::AutomatedVerificationOrException);
    }
    if input.human_verification_required && !input.human_verification_present {
        missing.push(PromotionRequirement::RequiredHumanVerification);
    }
    if !input.human_confirmed {
        missing.push(PromotionRequirement::HumanConfirmation);
    }
    if !input
        .applicability
        .iter()
        .any(|value| !value.trim().is_empty())
    {
        missing.push(PromotionRequirement::Applicability);
    }
    if !input
        .limitations
        .iter()
        .any(|value| !value.trim().is_empty())
    {
        missing.push(PromotionRequirement::Limitations);
    }
    if input.decisive_difference.trim().is_empty() {
        missing.push(PromotionRequirement::DecisiveDifference);
    }
    PromotionEvaluation {
        eligible: missing.is_empty(),
        missing_requirements: missing,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegressionOutcome {
    Regressed,
    OutsideApplicability,
    DifferentFingerprint,
}

pub fn evaluate_regression(
    fingerprint_matches: bool,
    boundary: &ApplicabilityBoundary,
    observed_context: &[(&str, &str)],
) -> RegressionOutcome {
    if !fingerprint_matches {
        return RegressionOutcome::DifferentFingerprint;
    }
    let observed = observed_context.iter().copied().collect::<BTreeMap<_, _>>();
    let inside = !boundary.is_empty()
        && boundary.iter().all(|(dimension, allowed)| {
            observed.get(dimension.as_str()).is_some_and(|value| {
                !allowed.is_empty() && allowed.iter().any(|candidate| candidate == value)
            })
        });
    if inside {
        RegressionOutcome::Regressed
    } else {
        RegressionOutcome::OutsideApplicability
    }
}

const COMMON_TERMS: &[&str] = &[
    "build", "test", "tests", "project", "change", "update", "error", "issue", "fix", "with",
    "from", "this", "that", "keep", "verify", "the", "and", "for",
];

#[derive(Debug, Clone)]
pub struct RelevanceCandidate {
    pub case_id: String,
    pub case_title: String,
    pub case_status: NodeStatus,
    pub nodes: Vec<NodeRecord>,
    pub guardrails: Vec<PreflightGuardrail>,
}

#[derive(Debug, Clone)]
pub struct RelevanceContext {
    pub task_description: String,
    pub changed_files: Vec<String>,
    pub command: Vec<String>,
    pub fingerprint_case_ids: Vec<String>,
    pub now_epoch_ms: i64,
}

pub fn rank_cases(
    context: &RelevanceContext,
    candidates: Vec<RelevanceCandidate>,
) -> Vec<PreflightCard> {
    let task = context.task_description.to_lowercase();
    let files = context
        .changed_files
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    let command = context.command.join(" ").to_lowercase();
    let mut meaningful_terms = Vec::new();
    for term in lexical_tokens(&format!("{task} {} {command}", files.join(" "))) {
        if term.chars().count() >= 3
            && !COMMON_TERMS.contains(&term.as_str())
            && !meaningful_terms.contains(&term)
        {
            meaningful_terms.push(term);
        }
    }
    let fingerprint_cases = context.fingerprint_case_ids.iter().collect::<BTreeSet<_>>();
    let mut cards = Vec::new();
    for candidate in candidates {
        let serialized = format!(
            "{} {}",
            candidate.case_title,
            serde_json::to_string(&candidate.nodes).unwrap_or_default()
        )
        .to_lowercase();
        let mut reasons = Vec::new();
        let mut score = 0.0;
        if fingerprint_cases.contains(&candidate.case_id) {
            score += 1000.0;
            reasons.push(MatchReason {
                kind: MatchKind::ExactFingerprint,
                value: "normalized failure fingerprint".into(),
            });
        }
        if candidate.guardrails.iter().any(|item| item.blocks) {
            score += 900.0;
            reasons.push(MatchReason {
                kind: MatchKind::BlockingGuardrail,
                value: "verified blocking guardrail".into(),
            });
        }
        if let Some(file) = files
            .iter()
            .find(|file| !file.is_empty() && serialized.contains(file.as_str()))
        {
            score += 500.0;
            reasons.push(MatchReason {
                kind: MatchKind::ExactFile,
                value: file.clone(),
            });
        }
        if !command.is_empty() && serialized.contains(&command) {
            score += 350.0;
            reasons.push(MatchReason {
                kind: MatchKind::ExactCommand,
                value: command.clone(),
            });
        }
        if candidate.nodes.iter().any(|node| {
            node.status == NodeStatus::Verified
                && matches!(node.node_type, NodeType::RootCause | NodeType::Solution)
        }) {
            score += 200.0;
            reasons.push(MatchReason {
                kind: MatchKind::VerifiedKnowledge,
                value: "verified root cause or solution".into(),
            });
        }
        let matches = meaningful_terms
            .iter()
            .filter(|term| serialized.contains(term.as_str()))
            .take(4)
            .cloned()
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            score += (matches.len() * 40) as f64;
            reasons.push(MatchReason {
                kind: MatchKind::Text,
                value: matches
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
            });
        }
        let newest = candidate
            .nodes
            .iter()
            .filter_map(|node| parse_iso_epoch_ms(&node.created_at))
            .max()
            .unwrap_or(context.now_epoch_ms);
        let age_days = (context.now_epoch_ms - newest) as f64 / 86_400_000.0;
        if candidate
            .nodes
            .iter()
            .any(|node| node.status == NodeStatus::Candidate)
        {
            if age_days >= 90.0 {
                score -= 400.0;
            } else if age_days >= 30.0 {
                score -= 80.0;
            }
        }
        if candidate.case_status == NodeStatus::Regressed {
            score -= 250.0;
        }
        if candidate.case_status == NodeStatus::Retired {
            score -= 1000.0;
        }
        if score <= 0.0 || reasons.is_empty() {
            continue;
        }
        cards.push(PreflightCard {
            case_id: candidate.case_id,
            case_title: candidate.case_title,
            score,
            why_matched: reasons,
            failed_attempt: newest_node(&candidate.nodes, |node| {
                node.node_type == NodeType::Attempt
                    && node.data.get("outcome").and_then(Value::as_str) == Some("failed")
            }),
            root_cause: newest_node(&candidate.nodes, |node| {
                node.node_type == NodeType::RootCause && node.status == NodeStatus::Verified
            }),
            solution: newest_node(&candidate.nodes, |node| {
                node.node_type == NodeType::Solution && node.status == NodeStatus::Verified
            }),
            guardrails: (!candidate.guardrails.is_empty()).then_some(candidate.guardrails),
        });
    }
    cards.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.case_id.cmp(&right.case_id))
    });
    cards
}

pub fn compact_preflight(mut input: PreflightResult, max_bytes: usize) -> PreflightResult {
    let original_ids = input
        .cards
        .iter()
        .map(|card| card.case_id.clone())
        .collect::<Vec<_>>();
    input.cards = input.cards.into_iter().take(5).map(compact_card).collect();
    rebuild_preflight_projections(&mut input);
    input.truncated |= original_ids.len() > input.cards.len();
    input.expansion_case_ids = original_ids.into_iter().skip(input.cards.len()).collect();
    while serde_json::to_vec(&input).map_or(usize::MAX, |value| value.len()) >= max_bytes
        && input.cards.len() > 1
    {
        if let Some(removed) = input.cards.pop() {
            input.expansion_case_ids.insert(0, removed.case_id);
        }
        input.truncated = true;
        rebuild_preflight_projections(&mut input);
    }
    if serde_json::to_vec(&input).map_or(usize::MAX, |value| value.len()) >= max_bytes
        && !input.uncertain.is_empty()
    {
        input.uncertain.clear();
        input.truncated = true;
    }
    input
}

fn newest_node(
    nodes: &[NodeRecord],
    predicate: impl Fn(&NodeRecord) -> bool,
) -> Option<NodeRecord> {
    nodes
        .iter()
        .filter(|node| predicate(node))
        .max_by(|left, right| left.created_at.cmp(&right.created_at))
        .cloned()
}

fn compact_card(mut card: PreflightCard) -> PreflightCard {
    card.case_title = card.case_title.chars().take(300).collect();
    card.why_matched.truncate(4);
    card.failed_attempt = card.failed_attempt.map(compact_node);
    card.root_cause = card.root_cause.map(compact_node);
    card.solution = card.solution.map(compact_node);
    if let Some(guardrails) = &mut card.guardrails {
        guardrails.truncate(2);
        for item in guardrails {
            item.node = compact_node(item.node.clone());
        }
    }
    card
}

fn compact_node(mut node: NodeRecord) -> NodeRecord {
    node.data = node
        .data
        .into_iter()
        .take(8)
        .map(|(key, value)| {
            let compact = match value {
                Value::String(text) => Value::String(text.chars().take(160).collect()),
                Value::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .take(3)
                        .map(|item| match item {
                            Value::String(text) => Value::String(text.chars().take(120).collect()),
                            other => other,
                        })
                        .collect(),
                ),
                other => other,
            };
            (key, compact)
        })
        .collect();
    node
}

fn rebuild_preflight_projections(result: &mut PreflightResult) {
    result.guardrails = result
        .cards
        .iter()
        .flat_map(|card| card.guardrails.clone().unwrap_or_default())
        .collect();
    result.failed_attempts = result
        .cards
        .iter()
        .filter_map(|card| card.failed_attempt.clone())
        .collect();
    result.root_causes = result
        .cards
        .iter()
        .filter_map(|card| card.root_cause.clone())
        .collect();
    result.solutions = result
        .cards
        .iter()
        .filter_map(|card| card.solution.clone())
        .collect();
    result.uncertain = result
        .uncertain
        .clone()
        .into_iter()
        .take(3)
        .map(compact_node)
        .collect();
}

fn parse_iso_epoch_ms(value: &str) -> Option<i64> {
    if value.len() < 19 {
        return None;
    }
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<i64>().ok()?;
    let minute = value.get(14..16)?.parse::<i64>().ok()?;
    let second = value.get(17..19)?.parse::<i64>().ok()?;
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    Some(((days_since_epoch * 24 + hour) * 60 * 60 + minute * 60 + second) * 1000)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeRecord {
    pub case_id: String,
    pub domain: String,
    pub text: String,
}

#[derive(Debug)]
struct RadixEdge {
    label: String,
    node: RadixNode,
}

#[derive(Debug, Default)]
struct RadixNode {
    children: BTreeMap<char, RadixEdge>,
    case_ids: BTreeSet<usize>,
}

impl RadixNode {
    fn insert(&mut self, token: &str, case_id: usize) {
        let mut node = self;
        let mut remainder = token;
        while !remainder.is_empty() {
            let first = remainder.chars().next().expect("non-empty remainder");
            let Some(mut edge) = node.children.remove(&first) else {
                node.children.insert(
                    first,
                    RadixEdge {
                        label: remainder.to_owned(),
                        node: RadixNode {
                            case_ids: BTreeSet::from([case_id]),
                            ..RadixNode::default()
                        },
                    },
                );
                return;
            };
            let common = common_prefix_bytes(&edge.label, remainder);
            if common == edge.label.len() {
                edge.node.case_ids.insert(case_id);
                remainder = &remainder[common..];
                node.children.insert(first, edge);
                if remainder.is_empty() {
                    return;
                }
                node = &mut node.children.get_mut(&first).expect("edge restored").node;
                continue;
            }

            let prefix = edge.label[..common].to_owned();
            let old_suffix = edge.label[common..].to_owned();
            let old_first = old_suffix.chars().next().expect("non-empty old suffix");
            edge.label = old_suffix;
            let mut intermediate = RadixNode {
                case_ids: edge.node.case_ids.clone(),
                ..RadixNode::default()
            };
            intermediate.case_ids.insert(case_id);
            intermediate.children.insert(old_first, edge);
            let new_suffix = &remainder[common..];
            if !new_suffix.is_empty() {
                let new_first = new_suffix.chars().next().expect("non-empty new suffix");
                intermediate.children.insert(
                    new_first,
                    RadixEdge {
                        label: new_suffix.to_owned(),
                        node: RadixNode {
                            case_ids: BTreeSet::from([case_id]),
                            ..RadixNode::default()
                        },
                    },
                );
            }
            node.children.insert(
                first,
                RadixEdge {
                    label: prefix,
                    node: intermediate,
                },
            );
            return;
        }
    }

    fn prefix_cases(&self, prefix: &str) -> BTreeSet<usize> {
        let mut node = self;
        let mut remainder = prefix;
        while !remainder.is_empty() {
            let first = remainder.chars().next().expect("non-empty remainder");
            let Some(edge) = node.children.get(&first) else {
                return BTreeSet::new();
            };
            let common = common_prefix_bytes(&edge.label, remainder);
            if common == remainder.len() {
                return edge.node.case_ids.clone();
            }
            if common != edge.label.len() {
                return BTreeSet::new();
            }
            remainder = &remainder[common..];
            node = &edge.node;
        }
        node.case_ids.clone()
    }

    fn node_count(&self) -> usize {
        1 + self
            .children
            .values()
            .map(|edge| edge.node.node_count())
            .sum::<usize>()
    }
}

fn common_prefix_bytes(left: &str, right: &str) -> usize {
    left.chars()
        .zip(right.chars())
        .take_while(|(left, right)| left == right)
        .map(|(character, _)| character.len_utf8())
        .sum()
}

/// Project-scoped deterministic routing tree.
///
/// The hierarchy is project (one index instance) -> domain -> Unicode prefix
/// radix tree -> Case IDs. Graph expansion and community summaries are later stages;
/// this tree is the bounded first-stage candidate router.
#[derive(Debug, Default)]
pub struct HierarchicalIndex {
    case_ids: Vec<String>,
    case_id_lookup: BTreeMap<String, usize>,
    domains: BTreeMap<String, RadixNode>,
    all: RadixNode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterStats {
    pub unique_cases: usize,
    pub all_radix_nodes: usize,
    pub domain_radix_nodes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteHit {
    pub case_id: String,
    pub score: usize,
    pub matched_routes: Vec<String>,
    pub domain_scoped: bool,
}

impl HierarchicalIndex {
    pub fn insert(&mut self, record: &KnowledgeRecord) {
        let case_id = if let Some(case_id) = self.case_id_lookup.get(&record.case_id) {
            *case_id
        } else {
            let case_id = self.case_ids.len();
            self.case_ids.push(record.case_id.clone());
            self.case_id_lookup.insert(record.case_id.clone(), case_id);
            case_id
        };
        for token in index_tokens(&record.text) {
            self.all.insert(&token, case_id);
            self.domains
                .entry(record.domain.to_lowercase())
                .or_default()
                .insert(&token, case_id);
        }
    }

    pub fn stats(&self) -> RouterStats {
        RouterStats {
            unique_cases: self.case_ids.len(),
            all_radix_nodes: self.all.node_count(),
            domain_radix_nodes: self.domains.values().map(RadixNode::node_count).sum(),
        }
    }

    pub fn search(&self, query: &str, domain: Option<&str>, limit: usize) -> Vec<String> {
        self.search_scored(query, domain, limit)
            .into_iter()
            .map(|hit| hit.case_id)
            .collect()
    }

    pub fn search_scored(&self, query: &str, domain: Option<&str>, limit: usize) -> Vec<RouteHit> {
        if limit == 0 {
            return Vec::new();
        }
        let domain_scoped = domain
            .and_then(|value| self.domains.get(&value.to_lowercase()))
            .is_some();
        let trie = domain
            .and_then(|value| self.domains.get(&value.to_lowercase()))
            .unwrap_or(&self.all);
        let routes = query_routes(query);
        let mut scores = BTreeMap::<String, (usize, BTreeSet<String>)>::new();
        for route in routes {
            for case_index in trie.prefix_cases(&route) {
                let case_id = self.case_ids[case_index].clone();
                let entry = scores.entry(case_id).or_default();
                entry.0 += 1;
                entry.1.insert(route.clone());
            }
        }
        let mut ranked = scores.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|(left_id, left), (right_id, right)| {
            right.0.cmp(&left.0).then_with(|| left_id.cmp(right_id))
        });
        ranked
            .into_iter()
            .take(limit)
            .map(|(case_id, (score, matched_routes))| RouteHit {
                case_id,
                score,
                matched_routes: matched_routes.into_iter().take(8).collect(),
                domain_scoped,
            })
            .collect()
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GuardrailCriteria {
    pub task_includes_all: Vec<String>,
    pub task_includes_any: Vec<String>,
    pub command_includes_all: Vec<String>,
    pub command_includes_any: Vec<String>,
    pub file_includes_all: Vec<String>,
    pub file_includes_any: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct GuardrailContext<'a> {
    pub task: &'a str,
    pub command: &'a str,
    pub files: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardrailEnforcement {
    Advise,
    Warn,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuardrailEvaluation {
    pub matches: bool,
    pub blocks: bool,
}

pub fn evaluate_guardrail(
    criteria: &GuardrailCriteria,
    status: NodeStatus,
    enforcement: GuardrailEnforcement,
    context: GuardrailContext<'_>,
) -> GuardrailEvaluation {
    let matches = criteria.matches(context);
    GuardrailEvaluation {
        matches,
        blocks: matches
            && status == NodeStatus::Verified
            && enforcement == GuardrailEnforcement::Block,
    }
}

impl GuardrailCriteria {
    pub fn matches(&self, context: GuardrailContext<'_>) -> bool {
        let checks = [
            match_dimension(
                context.task,
                &self.task_includes_all,
                &self.task_includes_any,
            ),
            match_dimension(
                context.command,
                &self.command_includes_all,
                &self.command_includes_any,
            ),
            match_dimension(
                context.files,
                &self.file_includes_all,
                &self.file_includes_any,
            ),
        ];
        let populated = checks.iter().filter_map(|value| *value).collect::<Vec<_>>();
        !populated.is_empty() && populated.into_iter().all(|value| value)
    }
}

fn match_dimension(haystack: &str, all: &[String], any: &[String]) -> Option<bool> {
    if all.is_empty() && any.is_empty() {
        return None;
    }
    let normalized = haystack.to_lowercase();
    let all_match = all
        .iter()
        .all(|needle| normalized.contains(&needle.to_lowercase()));
    let any_match = any.is_empty()
        || any
            .iter()
            .any(|needle| normalized.contains(&needle.to_lowercase()));
    Some(all_match && any_match)
}

fn index_tokens(text: &str) -> BTreeSet<String> {
    lexical_tokens(text)
        .into_iter()
        .flat_map(|token| {
            let mut values = vec![token.clone()];
            if is_han_compound(&token) {
                values.extend(han_bigrams(&token));
            }
            values
        })
        .collect()
}

fn query_routes(text: &str) -> BTreeSet<String> {
    lexical_tokens(text)
        .into_iter()
        .flat_map(|token| {
            if is_han_compound(&token) {
                let mut values = han_bigrams(&token);
                values.push(token);
                values
            } else {
                vec![token]
            }
        })
        .collect()
}

fn lexical_tokens(text: &str) -> Vec<String> {
    text.split(|character: char| {
        !(character.is_alphanumeric() || matches!(character, '_' | '.' | '-'))
    })
    .filter(|value| !value.is_empty())
    .map(str::to_lowercase)
    .collect()
}

fn is_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn is_han_compound(token: &str) -> bool {
    token.chars().count() >= 3 && token.chars().all(is_han)
}

fn han_bigrams(token: &str) -> Vec<String> {
    let characters = token.chars().collect::<Vec<_>>();
    characters
        .windows(2)
        .map(|pair| pair.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_recalls_compound_chinese_with_missing_middle_words() {
        let mut index = HierarchicalIndex::default();
        index.insert(&KnowledgeRecord {
            case_id: "validation-standard".into(),
            domain: "workflow".into(),
            text: "轻量代码修复采用三级风险验证门禁".into(),
        });
        index.insert(&KnowledgeRecord {
            case_id: "media-pipeline".into(),
            domain: "media".into(),
            text: "视频解码与模型推理优化".into(),
        });

        assert_eq!(
            index.search("轻量修复 三级验证门禁", None, 5),
            vec!["validation-standard"],
        );
        assert!(index.search("轻量修复", Some("media"), 5).is_empty());
    }

    #[test]
    fn guardrail_keeps_all_of_and_adds_explicit_any_of_semantics() {
        let criteria = GuardrailCriteria {
            task_includes_any: vec!["轻量修复".into(), "small fix".into()],
            command_includes_all: vec!["git".into(), "diff".into()],
            ..GuardrailCriteria::default()
        };
        assert!(criteria.matches(GuardrailContext {
            task: "开始轻量修复",
            command: "git diff --check",
            files: "",
        }));
        assert!(!criteria.matches(GuardrailContext {
            task: "开始轻量修复",
            command: "git status",
            files: "",
        }));
    }
}
