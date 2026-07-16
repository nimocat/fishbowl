//! Rust retrieval and policy core for Engineering Knowledge Graph.
//!
//! The first migration slice intentionally has no third-party dependencies. It
//! establishes deterministic Unicode routing and Guardrail semantics before
//! storage and graph traversal move across the daemon boundary.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeRecord {
    pub case_id: String,
    pub domain: String,
    pub text: String,
}

#[derive(Debug, Default)]
struct TrieNode {
    children: BTreeMap<char, TrieNode>,
    case_ids: BTreeSet<String>,
}

impl TrieNode {
    fn insert(&mut self, token: &str, case_id: &str) {
        let mut node = self;
        for character in token.chars() {
            node = node.children.entry(character).or_default();
            node.case_ids.insert(case_id.to_owned());
        }
    }

    fn prefix_cases(&self, prefix: &str) -> BTreeSet<String> {
        let mut node = self;
        for character in prefix.chars() {
            let Some(next) = node.children.get(&character) else {
                return BTreeSet::new();
            };
            node = next;
        }
        node.case_ids.clone()
    }
}

/// Project-scoped deterministic routing tree.
///
/// The hierarchy is project (one index instance) -> domain -> Unicode prefix
/// trie -> Case IDs. Graph expansion and community summaries are later stages;
/// this tree is the bounded first-stage candidate router.
#[derive(Debug, Default)]
pub struct HierarchicalIndex {
    domains: BTreeMap<String, TrieNode>,
    all: TrieNode,
}

impl HierarchicalIndex {
    pub fn insert(&mut self, record: &KnowledgeRecord) {
        for token in index_tokens(&record.text) {
            self.all.insert(&token, &record.case_id);
            self.domains
                .entry(record.domain.to_lowercase())
                .or_default()
                .insert(&token, &record.case_id);
        }
    }

    pub fn search(&self, query: &str, domain: Option<&str>, limit: usize) -> Vec<String> {
        if limit == 0 {
            return Vec::new();
        }
        let trie = domain
            .and_then(|value| self.domains.get(&value.to_lowercase()))
            .unwrap_or(&self.all);
        let routes = query_routes(query);
        let mut scores = BTreeMap::<String, usize>::new();
        for route in routes {
            for case_id in trie.prefix_cases(&route) {
                *scores.entry(case_id).or_default() += 1;
            }
        }
        let mut ranked = scores.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|(left_id, left_score), (right_id, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| left_id.cmp(right_id))
        });
        ranked
            .into_iter()
            .take(limit)
            .map(|(case_id, _)| case_id)
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
