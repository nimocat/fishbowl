use std::collections::{BTreeMap, BTreeSet, VecDeque};

use ekg_contracts::NodeStatus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyRecord {
    pub project_id: String,
    pub domain: String,
    pub case_id: String,
    pub status: NodeStatus,
    pub text: String,
    pub fingerprints: Vec<String>,
    pub files: Vec<String>,
    pub commands: Vec<String>,
    pub verified_conclusion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyEdge {
    pub source_case_id: String,
    pub target_case_id: String,
}

impl HierarchyEdge {
    pub fn new(left: &str, right: &str) -> Self {
        if left <= right {
            Self {
                source_case_id: left.into(),
                target_case_id: right.into(),
            }
        } else {
            Self {
                source_case_id: right.into(),
                target_case_id: left.into(),
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportedConclusion {
    pub case_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySummary {
    pub id: String,
    pub core_level: usize,
    pub supporting_case_ids: Vec<String>,
    pub status_counts: BTreeMap<String, usize>,
    pub fingerprints: Vec<String>,
    pub files: Vec<String>,
    pub commands: Vec<String>,
    pub verified_conclusions: Vec<SupportedConclusion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DomainHierarchy {
    pub source_revision: i64,
    pub cases: Vec<String>,
    pub communities: Vec<CommunitySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedHierarchySummary {
    pub text: String,
    pub generator_version: String,
    pub status: NodeStatus,
    pub source_revision: i64,
    pub supporting_case_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HierarchySnapshot<'a> {
    revision: i64,
    branches: Vec<SnapshotBranch<'a>>,
    generated_summaries: Vec<SnapshotGeneratedSummary<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotBranch<'a> {
    project_id: &'a str,
    domain: &'a str,
    hierarchy: &'a DomainHierarchy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotGeneratedSummary<'a> {
    project_id: &'a str,
    domain: &'a str,
    summary: &'a GeneratedHierarchySummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalHierarchyHit {
    pub project_id: String,
    pub domain: String,
    pub community_id: String,
    pub score: usize,
    pub supporting_case_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalHierarchyHit {
    pub case_id: String,
    pub score: usize,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct KnowledgeHierarchy {
    revision: i64,
    records: BTreeMap<(String, String, String), HierarchyRecord>,
    edges: BTreeSet<HierarchyEdge>,
    branches: BTreeMap<(String, String), DomainHierarchy>,
    generated_summaries: BTreeMap<(String, String), GeneratedHierarchySummary>,
    last_rebuilt_branches: Vec<(String, String)>,
}

impl KnowledgeHierarchy {
    pub fn build(revision: i64, records: Vec<HierarchyRecord>, edges: Vec<HierarchyEdge>) -> Self {
        let mut hierarchy = Self {
            revision,
            edges: edges.into_iter().collect(),
            ..Self::default()
        };
        for record in records {
            hierarchy.records.insert(
                (
                    record.project_id.clone(),
                    record.domain.clone(),
                    record.case_id.clone(),
                ),
                record,
            );
        }
        let branches = hierarchy
            .records
            .keys()
            .map(|(project, domain, _)| (project.clone(), domain.clone()))
            .collect::<BTreeSet<_>>();
        for branch in branches {
            hierarchy.rebuild_branch(&branch);
        }
        hierarchy.last_rebuilt_branches.clear();
        hierarchy
    }

    pub fn upsert(&mut self, revision: i64, record: HierarchyRecord) {
        let mut affected = self
            .records
            .keys()
            .filter(|(project, _, case_id)| {
                project == &record.project_id && case_id == &record.case_id
            })
            .map(|(project, domain, _)| (project.clone(), domain.clone()))
            .collect::<BTreeSet<_>>();
        self.records.retain(|(project, _, case_id), _| {
            !(project == &record.project_id && case_id == &record.case_id)
        });
        let branch = (record.project_id.clone(), record.domain.clone());
        self.records.insert(
            (
                record.project_id.clone(),
                record.domain.clone(),
                record.case_id.clone(),
            ),
            record,
        );
        affected.insert(branch);
        self.revision = revision;
        self.last_rebuilt_branches.clear();
        for branch in affected {
            self.rebuild_branch(&branch);
        }
    }

    pub fn snapshot_json(&self) -> serde_json::Result<Vec<u8>> {
        let branches = self
            .branches
            .iter()
            .map(|((project, domain), hierarchy)| SnapshotBranch {
                project_id: project,
                domain,
                hierarchy,
            })
            .collect();
        let generated_summaries = self
            .generated_summaries
            .iter()
            .map(|((project, domain), summary)| SnapshotGeneratedSummary {
                project_id: project,
                domain,
                summary,
            })
            .collect();
        serde_json::to_vec(&HierarchySnapshot {
            revision: self.revision,
            branches,
            generated_summaries,
        })
    }

    pub fn branch_json(&self, project: &str, domain: &str) -> Option<Vec<u8>> {
        self.branches
            .get(&(project.into(), domain.into()))
            .and_then(|branch| serde_json::to_vec(branch).ok())
    }

    pub fn branch_source_revision(&self, project: &str, domain: &str) -> Option<i64> {
        self.branches
            .get(&(project.into(), domain.into()))
            .map(|branch| branch.source_revision)
    }

    pub fn last_rebuilt_branches(&self) -> &[(String, String)] {
        &self.last_rebuilt_branches
    }

    pub fn query_global(
        &self,
        project: &str,
        query: &str,
        limit: usize,
    ) -> Vec<GlobalHierarchyHit> {
        let routes = query_terms(query);
        let mut hits = Vec::new();
        for ((branch_project, domain), branch) in &self.branches {
            if branch_project != project {
                continue;
            }
            for community in &branch.communities {
                let searchable = format!(
                    "{domain} {} {} {}",
                    community.files.join(" "),
                    community.commands.join(" "),
                    community
                        .verified_conclusions
                        .iter()
                        .map(|item| item.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                )
                .to_lowercase();
                let score = routes
                    .iter()
                    .filter(|term| searchable.contains(term.as_str()))
                    .count();
                if score > 0 {
                    hits.push(GlobalHierarchyHit {
                        project_id: project.into(),
                        domain: domain.clone(),
                        community_id: community.id.clone(),
                        score,
                        supporting_case_ids: community.supporting_case_ids.clone(),
                    });
                }
            }
        }
        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.community_id.cmp(&right.community_id))
        });
        hits.truncate(limit);
        hits
    }

    pub fn query_local(
        &self,
        project: &str,
        domain: &str,
        query: &str,
        limit: usize,
    ) -> Vec<LocalHierarchyHit> {
        let routes = query_terms(query);
        let mut hits = self
            .records
            .iter()
            .filter_map(|((record_project, record_domain, _), record)| {
                if record_project != project || record_domain != domain {
                    return None;
                }
                let normalized = record.text.to_lowercase();
                let score = routes
                    .iter()
                    .filter(|term| normalized.contains(term.as_str()))
                    .count();
                (score > 0).then(|| LocalHierarchyHit {
                    case_id: record.case_id.clone(),
                    score,
                    text: record.text.clone(),
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.case_id.cmp(&right.case_id))
        });
        hits.truncate(limit);
        hits
    }

    pub fn attach_generated_summary(
        &mut self,
        project: &str,
        domain: &str,
        text: &str,
        generator_version: &str,
    ) -> Option<GeneratedHierarchySummary> {
        self.branches.get(&(project.into(), domain.into()))?;
        let summary = GeneratedHierarchySummary {
            text: text.into(),
            generator_version: generator_version.into(),
            status: NodeStatus::Candidate,
            source_revision: self.revision,
            supporting_case_ids: Vec::new(),
        };
        self.generated_summaries
            .insert((project.into(), domain.into()), summary.clone());
        Some(summary)
    }

    fn rebuild_branch(&mut self, branch: &(String, String)) {
        let records = self
            .records
            .iter()
            .filter(|((project, domain, _), _)| project == &branch.0 && domain == &branch.1)
            .map(|(_, record)| record)
            .collect::<Vec<_>>();
        if records.is_empty() {
            self.branches.remove(branch);
            self.last_rebuilt_branches.push(branch.clone());
            return;
        }
        let cases = records
            .iter()
            .map(|record| record.case_id.clone())
            .collect::<BTreeSet<_>>();
        let adjacency = adjacency(&cases, &self.edges);
        let components = connected_components(&cases, &adjacency);
        let mut communities = components
            .into_iter()
            .map(|component| summarize_component(&branch.1, &component, &records, &adjacency))
            .collect::<Vec<_>>();
        communities.sort_by(|left, right| left.id.cmp(&right.id));
        self.branches.insert(
            branch.clone(),
            DomainHierarchy {
                source_revision: self.revision,
                cases: cases.into_iter().collect(),
                communities,
            },
        );
        self.generated_summaries.remove(branch);
        self.last_rebuilt_branches.push(branch.clone());
    }
}

fn adjacency(
    cases: &BTreeSet<String>,
    edges: &BTreeSet<HierarchyEdge>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut result = cases
        .iter()
        .map(|case_id| (case_id.clone(), BTreeSet::new()))
        .collect::<BTreeMap<_, _>>();
    for edge in edges {
        if cases.contains(&edge.source_case_id) && cases.contains(&edge.target_case_id) {
            result
                .entry(edge.source_case_id.clone())
                .or_default()
                .insert(edge.target_case_id.clone());
            result
                .entry(edge.target_case_id.clone())
                .or_default()
                .insert(edge.source_case_id.clone());
        }
    }
    result
}

fn connected_components(
    cases: &BTreeSet<String>,
    adjacency: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<Vec<String>> {
    let mut remaining = cases.clone();
    let mut result = Vec::new();
    while let Some(start) = remaining.first().cloned() {
        let mut queue = VecDeque::from([start]);
        let mut component = Vec::new();
        while let Some(case_id) = queue.pop_front() {
            if !remaining.remove(&case_id) {
                continue;
            }
            component.push(case_id.clone());
            for neighbor in adjacency.get(&case_id).into_iter().flatten() {
                if remaining.contains(neighbor) {
                    queue.push_back(neighbor.clone());
                }
            }
        }
        component.sort();
        result.push(component);
    }
    result
}

fn summarize_component(
    domain: &str,
    component: &[String],
    records: &[&HierarchyRecord],
    adjacency: &BTreeMap<String, BTreeSet<String>>,
) -> CommunitySummary {
    let core_numbers = deterministic_core_numbers(component, adjacency);
    let core_level = core_numbers.values().copied().max().unwrap_or(0);
    let mut statuses = BTreeMap::new();
    let mut fingerprints = BTreeSet::new();
    let mut files = BTreeSet::new();
    let mut commands = BTreeSet::new();
    let mut conclusions = Vec::new();
    for record in records
        .iter()
        .filter(|record| component.contains(&record.case_id))
    {
        *statuses
            .entry(status_name(record.status).to_owned())
            .or_insert(0) += 1;
        fingerprints.extend(record.fingerprints.iter().cloned());
        files.extend(record.files.iter().cloned());
        commands.extend(record.commands.iter().cloned());
        if record.status == NodeStatus::Verified {
            if let Some(text) = &record.verified_conclusion {
                conclusions.push(SupportedConclusion {
                    case_id: record.case_id.clone(),
                    text: text.clone(),
                });
            }
        }
    }
    conclusions.sort_by(|left, right| left.case_id.cmp(&right.case_id));
    CommunitySummary {
        id: format!(
            "{domain}:k{core_level}:{}",
            component.first().cloned().unwrap_or_default()
        ),
        core_level,
        supporting_case_ids: component.to_vec(),
        status_counts: statuses,
        fingerprints: fingerprints.into_iter().collect(),
        files: files.into_iter().collect(),
        commands: commands.into_iter().collect(),
        verified_conclusions: conclusions,
    }
}

fn deterministic_core_numbers(
    component: &[String],
    adjacency: &BTreeMap<String, BTreeSet<String>>,
) -> BTreeMap<String, usize> {
    let component_set = component.iter().collect::<BTreeSet<_>>();
    let mut degrees = component
        .iter()
        .map(|case_id| {
            (
                case_id.clone(),
                adjacency.get(case_id).map_or(0, |neighbors| {
                    neighbors
                        .iter()
                        .filter(|neighbor| component_set.contains(neighbor))
                        .count()
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut queue = degrees
        .iter()
        .map(|(case_id, degree)| (*degree, case_id.clone()))
        .collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    while let Some((degree, case_id)) = queue.pop_first() {
        result.insert(case_id.clone(), degree);
        for neighbor in adjacency.get(&case_id).into_iter().flatten() {
            if !result.contains_key(neighbor) {
                let neighbor_degree = degrees.get(neighbor).copied().unwrap_or(0);
                if neighbor_degree > degree {
                    queue.remove(&(neighbor_degree, neighbor.clone()));
                    degrees.insert(neighbor.clone(), neighbor_degree - 1);
                    queue.insert((neighbor_degree - 1, neighbor.clone()));
                }
            }
        }
    }
    result
}

fn status_name(status: NodeStatus) -> &'static str {
    match status {
        NodeStatus::Open => "open",
        NodeStatus::Candidate => "candidate",
        NodeStatus::Verified => "verified",
        NodeStatus::Regressed => "regressed",
        NodeStatus::Retired => "retired",
    }
}

fn query_terms(query: &str) -> BTreeSet<String> {
    query
        .split(|character: char| {
            !(character.is_alphanumeric() || matches!(character, '_' | '.' | '-'))
        })
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect()
}
