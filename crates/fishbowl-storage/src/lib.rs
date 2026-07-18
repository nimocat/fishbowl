//! Project-scoped, query-only repository for the existing Fishbowl SQLite schema.

mod disk;
mod import;
mod schema;
mod snapshot;
mod write;

pub use disk::{
    DiskCapture, DiskDirectoryStamp, DiskMeasurementCacheEntry, DiskSnapshot, DiskSnapshotEntry,
    capture_project_disk, capture_project_disk_cached, capture_project_disk_incremental,
};
pub use schema::*;
pub use write::*;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::Instant;

use fishbowl_contracts::{
    ArtifactRecord, CaseCounts, CaseDetailLevel, CleanupDisposition, CommandRunRecord,
    DiskArtifactKind, DiskCleanupCandidate, DiskObservationSummary, EdgeRecord, ErrorCode,
    EvidenceKind, EvidenceRecord, GetCaseInput, GetCaseResult, GetOperationResultInput,
    KnowledgeEvent, KnowledgeQueryItem, ListCleanupCandidatesInput, ListCleanupCandidatesResult,
    ListDiskObservationsInput, ListDiskObservationsResult, NodeRecord, NodeStatus, NodeType,
    OperationResultLookup, PreflightGuardrail, PreflightInput, PreflightResult, ProjectAliasRecord,
    ProjectRecord, ProjectReference, ProjectWithAliasesRecord, QueryKnowledgeInput,
    QueryKnowledgeResult, QueryResultMode, RecentActivityInput, RecentActivityResult, RelationType,
    RetrievalDiagnostics, RetrievalMatchKind, RetrievalMode, RetrievalReason, Validate,
};
use fishbowl_core::{
    ExpansionConfig, ExpansionEdge, ExpansionNode, ExpansionResult, GuardrailContext,
    GuardrailCriteria, GuardrailEnforcement, HierarchicalIndex, HierarchyEdge, HierarchyRecord,
    KnowledgeHierarchy, RelevanceCandidate, RelevanceContext, RouteHit, compact_preflight,
    evaluate_guardrail, expand_bounded, rank_cases,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::Value;

#[derive(Debug)]
pub enum StorageError {
    Contract(ErrorCode),
    Sqlite(rusqlite::Error),
    InvalidStoredData(&'static str),
    ProjectNotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightMetrics {
    pub cache_hit: bool,
    pub candidate_count: usize,
    pub card_count: usize,
    pub execution_micros: u128,
}

#[derive(Debug, Clone)]
pub struct PreflightExecution {
    pub result: PreflightResult,
    pub metrics: PreflightMetrics,
}

#[derive(Clone)]
struct CachedPreflight {
    result: PreflightResult,
    candidate_count: usize,
}

struct CachedRetrieval {
    revision: i64,
    router: HierarchicalIndex,
    hierarchy: KnowledgeHierarchy,
}

struct RankedQueryItem {
    item: KnowledgeQueryItem,
    score: u64,
}

impl From<rusqlite::Error> for StorageError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

pub struct ReadRepository {
    connection: Connection,
    preflight_cache: RefCell<BTreeMap<String, CachedPreflight>>,
    preflight_order: RefCell<VecDeque<String>>,
    retrieval_cache: RefCell<BTreeMap<String, CachedRetrieval>>,
}

impl ReadRepository {
    pub fn open(database_path: &str) -> Result<Self, StorageError> {
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "query_only", true)?;
        Ok(Self {
            connection,
            preflight_cache: RefCell::new(BTreeMap::new()),
            preflight_order: RefCell::new(VecDeque::new()),
            retrieval_cache: RefCell::new(BTreeMap::new()),
        })
    }

    pub fn query_knowledge(
        &self,
        input: &QueryKnowledgeInput,
    ) -> Result<QueryKnowledgeResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let limit = input.limit.unwrap_or(20);
        let text = input
            .text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut exact = self.query_exact_items(input, &project_id, limit.max(64))?;
        for item in &mut exact {
            if item.node.status == NodeStatus::Verified {
                push_reason(
                    &mut item.why_matched,
                    RetrievalMatchKind::VerifiedTrust,
                    "verified",
                );
            }
        }
        if text.is_none() || !exact.is_empty() {
            if !matches!(input.result_mode, Some(QueryResultMode::Nodes)) {
                retain_first_per_case(&mut exact);
            }
            let truncated = exact.len() > limit;
            exact.truncate(limit);
            return Ok(QueryKnowledgeResult {
                items: exact,
                limit,
                truncated,
                diagnostics: Some(RetrievalDiagnostics {
                    mode: RetrievalMode::Exact,
                    seed_count: 0,
                    candidate_case_count: 0,
                    visited_nodes: 0,
                    visited_edges: 0,
                    iterations: 0,
                }),
            });
        }
        self.query_hybrid(input, &project_id, text.unwrap(), limit, exact)
    }

    pub fn get_operation_result(
        &self,
        input: &GetOperationResultInput,
    ) -> Result<OperationResultLookup, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let row = self.connection.query_row(
            "SELECT kind, result, created_at FROM operation_results WHERE project_id = ? AND operation_id = ? AND (? IS NULL OR kind = ?)",
            params![project_id, input.operation_id, input.kind, input.kind],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).optional()?;
        let Some((kind, result, created_at)) = row else {
            return Ok(OperationResultLookup {
                found: false,
                operation_id: input.operation_id.clone(),
                kind: None,
                result: None,
                created_at: None,
            });
        };
        Ok(OperationResultLookup {
            found: true,
            operation_id: input.operation_id.clone(),
            kind: Some(kind),
            result: Some(
                serde_json::from_str(&result)
                    .map_err(|_| StorageError::InvalidStoredData("operation result"))?,
            ),
            created_at: Some(created_at),
        })
    }

    fn query_exact_items(
        &self,
        input: &QueryKnowledgeInput,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeQueryItem>, StorageError> {
        let mut conditions = vec!["cases.project_id = ?".to_owned()];
        let mut parameters = vec![SqlValue::Text(project_id.to_owned())];
        let mut search_join = "";

        if let Some(text) = input
            .text
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            search_join = "JOIN node_search ON node_search.node_id = nodes.id";
            if let Some(query) = build_fts_query(text) {
                conditions.push("node_search MATCH ?".to_owned());
                parameters.push(SqlValue::Text(query));
            } else {
                conditions.push("(node_search.title LIKE ? OR node_search.body LIKE ?)".to_owned());
                let term = format!("%{text}%");
                parameters.push(SqlValue::Text(term.clone()));
                parameters.push(SqlValue::Text(term));
            }
        }
        if let Some(types) = input.node_types.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(format!("nodes.type IN ({})", placeholders(types.len())));
            parameters.extend(
                types
                    .iter()
                    .map(|value| SqlValue::Text(node_type_text(*value).to_owned())),
            );
        }
        if let Some(statuses) = input.statuses.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(format!(
                "nodes.status IN ({})",
                placeholders(statuses.len())
            ));
            parameters.extend(
                statuses
                    .iter()
                    .map(|value| SqlValue::Text(status_text(*value).to_owned())),
            );
        }
        if let Some(domain) = trimmed(&input.domain) {
            conditions.push("EXISTS (SELECT 1 FROM nodes domain_node WHERE domain_node.case_id = cases.id AND domain_node.type = 'Problem' AND json_extract(domain_node.data, '$.domain') = ?)".to_owned());
            parameters.push(SqlValue::Text(domain.to_owned()));
        }
        if let Some(file) = trimmed(&input.file) {
            conditions.push("EXISTS (SELECT 1 FROM nodes file_node WHERE file_node.case_id = cases.id AND file_node.data LIKE ?)".to_owned());
            parameters.push(SqlValue::Text(format!("%{file}%")));
        }
        if let Some(command) = trimmed(&input.command) {
            conditions.push("(EXISTS (SELECT 1 FROM nodes command_node WHERE command_node.case_id = cases.id AND command_node.data LIKE ?) OR EXISTS (SELECT 1 FROM command_runs WHERE command_runs.case_id = cases.id AND command_runs.project_id = cases.project_id AND command_runs.command LIKE ?))".to_owned());
            let pattern = format!("%{command}%");
            parameters.push(SqlValue::Text(pattern.clone()));
            parameters.push(SqlValue::Text(pattern));
        }
        if let Some(fingerprint) = trimmed(&input.fingerprint) {
            conditions.push("EXISTS (SELECT 1 FROM fingerprints JOIN nodes problem_node ON problem_node.id = fingerprints.problem_node_id WHERE fingerprints.project_id = cases.project_id AND problem_node.case_id = cases.id AND fingerprints.value = ?)".to_owned());
            parameters.push(SqlValue::Text(fingerprint.to_owned()));
        }
        parameters.push(SqlValue::Integer((limit + 1) as i64));
        let exact_reasons = exact_reasons(input);
        let select = "nodes.id AS node_id, nodes.case_id AS case_id, nodes.type AS node_type, nodes.status AS node_status, nodes.data AS node_data, nodes.created_at AS node_created_at, cases.project_id AS project_id, cases.title AS case_title";
        let sql = if matches!(input.result_mode, Some(QueryResultMode::Nodes)) {
            format!(
                "SELECT {select} FROM nodes JOIN cases ON cases.id = nodes.case_id {search_join} WHERE {} ORDER BY nodes.created_at DESC, nodes.id DESC LIMIT ?",
                conditions.join(" AND ")
            )
        } else {
            format!(
                "SELECT node_id, case_id, node_type, node_status, node_data, node_created_at, project_id, case_title FROM (SELECT {select}, row_number() OVER (PARTITION BY nodes.case_id ORDER BY nodes.created_at DESC, nodes.id DESC) AS case_rank FROM nodes JOIN cases ON cases.id = nodes.case_id {search_join} WHERE {}) WHERE case_rank = 1 ORDER BY node_created_at DESC, node_id DESC LIMIT ?",
                conditions.join(" AND ")
            )
        };
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(parameters), |row| {
            let data_text: String = row.get(4)?;
            let data =
                serde_json::from_str::<BTreeMap<String, Value>>(&data_text).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            let node_type_text: String = row.get(2)?;
            let status_text: String = row.get(3)?;
            let node_type = parse_node_type(&node_type_text).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(2, "type".into(), rusqlite::types::Type::Text)
            })?;
            let status = parse_status(&status_text).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(3, "status".into(), rusqlite::types::Type::Text)
            })?;
            Ok(KnowledgeQueryItem {
                project_id: row.get(6)?,
                case_id: row.get(1)?,
                case_title: row.get(7)?,
                node: NodeRecord {
                    id: row.get(0)?,
                    case_id: row.get(1)?,
                    node_type,
                    status,
                    data,
                    created_at: row.get(5)?,
                },
                why_matched: exact_reasons.clone(),
                supporting_path: Vec::new(),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn query_hybrid(
        &self,
        input: &QueryKnowledgeInput,
        project_id: &str,
        text: &str,
        limit: usize,
        exact: Vec<KnowledgeQueryItem>,
    ) -> Result<QueryKnowledgeResult, StorageError> {
        const MAX_CANDIDATE_CASES: usize = 64;
        const MAX_SEEDS: usize = 16;
        self.ensure_retrieval_cache(project_id)?;
        let (route_hits, hierarchy_case_ids, shells) = {
            let cache = self.retrieval_cache.borrow();
            let cached = cache
                .get(project_id)
                .ok_or(StorageError::InvalidStoredData("retrieval cache"))?;
            let route_hits =
                cached
                    .router
                    .search_scored(text, input.domain.as_deref(), MAX_CANDIDATE_CASES);
            let hierarchy_hits = cached.hierarchy.query_global(project_id, text, 16);
            let hierarchy_case_ids = hierarchy_hits
                .iter()
                .flat_map(|hit| hit.supporting_case_ids.iter().cloned())
                .collect::<BTreeSet<_>>();
            let shells = route_hits
                .iter()
                .filter_map(|hit| {
                    cached
                        .hierarchy
                        .deepest_shell_for_case(project_id, &hit.case_id)
                        .map(|shell| (hit.case_id.clone(), shell))
                })
                .collect::<BTreeMap<_, _>>();
            (route_hits, hierarchy_case_ids, shells)
        };

        let mut candidate_case_ids = Vec::new();
        for case_id in exact
            .iter()
            .map(|item| item.case_id.clone())
            .chain(route_hits.iter().map(|hit| hit.case_id.clone()))
            .chain(hierarchy_case_ids.iter().cloned())
        {
            if !candidate_case_ids.contains(&case_id)
                && candidate_case_ids.len() < MAX_CANDIDATE_CASES
            {
                candidate_case_ids.push(case_id);
            }
        }
        let eligible = self.eligible_case_ids(input, project_id, &candidate_case_ids)?;
        candidate_case_ids.retain(|case_id| eligible.contains(case_id));
        let nodes = self.nodes_for_cases(project_id, &candidate_case_ids)?;
        let case_rows = self.case_rows(project_id, &candidate_case_ids)?;
        let case_titles = case_rows
            .into_iter()
            .map(|(id, title, _)| (id, title))
            .collect::<BTreeMap<_, _>>();
        let terms = retrieval_terms(text);
        let mut seed_scores = nodes
            .iter()
            .filter_map(|node| {
                let score = node_overlap(node, &terms);
                (score > 0).then(|| (node.id.clone(), score))
            })
            .collect::<Vec<_>>();
        for item in &exact {
            if let Some(found) = seed_scores
                .iter_mut()
                .find(|(node_id, _)| node_id == &item.node.id)
            {
                found.1 += 100;
            } else {
                seed_scores.push((item.node.id.clone(), 100));
            }
        }
        seed_scores.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        seed_scores.truncate(MAX_SEEDS);
        let seed_ids = seed_scores
            .iter()
            .map(|(node_id, _)| node_id.clone())
            .collect::<Vec<_>>();
        let graph = if candidate_case_ids.is_empty() || seed_ids.is_empty() {
            None
        } else {
            Some(self.expand_case_graph(
                &input.project,
                &candidate_case_ids,
                &seed_ids,
                &[],
                ExpansionConfig::default(),
            )?)
        };
        let route_by_case = route_hits
            .into_iter()
            .map(|hit| (hit.case_id.clone(), hit))
            .collect::<BTreeMap<_, _>>();
        let nodes_by_id = nodes
            .iter()
            .map(|node| (node.id.clone(), node.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut ranked = BTreeMap::<String, RankedQueryItem>::new();

        for mut item in exact {
            if !eligible.contains(&item.case_id) {
                continue;
            }
            let case_id = item.case_id.clone();
            append_route_reasons(
                &mut item,
                route_by_case.get(&case_id),
                shells.get(&case_id),
                hierarchy_case_ids.contains(&case_id),
                input.domain.as_deref(),
            );
            if item.node.status == NodeStatus::Verified {
                push_reason(
                    &mut item.why_matched,
                    RetrievalMatchKind::VerifiedTrust,
                    "verified",
                );
            }
            insert_ranked(
                &mut ranked,
                RankedQueryItem {
                    item,
                    score: 4_000_000,
                },
            );
        }

        if let Some(graph) = &graph {
            for hit in &graph.hits {
                let Some(node) = nodes_by_id.get(&hit.node_id) else {
                    continue;
                };
                if !node_matches_output_filters(node, input) {
                    continue;
                }
                let Some(case_title) = case_titles.get(&node.case_id) else {
                    continue;
                };
                let mut item = KnowledgeQueryItem {
                    project_id: project_id.to_owned(),
                    case_id: node.case_id.clone(),
                    case_title: case_title.clone(),
                    node: node.clone(),
                    why_matched: Vec::new(),
                    supporting_path: hit.supporting_path.iter().take(8).cloned().collect(),
                };
                let case_id = item.case_id.clone();
                append_route_reasons(
                    &mut item,
                    route_by_case.get(&case_id),
                    shells.get(&case_id),
                    hierarchy_case_ids.contains(&case_id),
                    input.domain.as_deref(),
                );
                if item.supporting_path.len() > 1 {
                    push_reason(
                        &mut item.why_matched,
                        RetrievalMatchKind::PprPath,
                        &item.supporting_path.join(" -> "),
                    );
                }
                if node.status == NodeStatus::Verified {
                    push_reason(
                        &mut item.why_matched,
                        RetrievalMatchKind::VerifiedTrust,
                        "verified",
                    );
                }
                insert_ranked(
                    &mut ranked,
                    RankedQueryItem {
                        item,
                        score: 1_000_000 + hit.score_micros,
                    },
                );
            }
        }

        for node in &nodes {
            if !node_matches_output_filters(node, input) || ranked.contains_key(&node.id) {
                continue;
            }
            let overlap = node_overlap(node, &terms);
            let Some(route) = route_by_case.get(&node.case_id) else {
                continue;
            };
            if overlap == 0 && graph.is_some() {
                continue;
            }
            let Some(case_title) = case_titles.get(&node.case_id) else {
                continue;
            };
            let mut item = KnowledgeQueryItem {
                project_id: project_id.to_owned(),
                case_id: node.case_id.clone(),
                case_title: case_title.clone(),
                node: node.clone(),
                why_matched: Vec::new(),
                supporting_path: Vec::new(),
            };
            let case_id = item.case_id.clone();
            append_route_reasons(
                &mut item,
                Some(route),
                shells.get(&case_id),
                hierarchy_case_ids.contains(&case_id),
                input.domain.as_deref(),
            );
            insert_ranked(
                &mut ranked,
                RankedQueryItem {
                    item,
                    score: 500_000 + overlap as u64 * 10_000 + route.score as u64,
                },
            );
        }

        let mut ranked = ranked.into_values().collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.item.node.id.cmp(&right.item.node.id))
        });
        if !matches!(input.result_mode, Some(QueryResultMode::Nodes)) {
            let mut cases = BTreeSet::new();
            ranked.retain(|ranked| cases.insert(ranked.item.case_id.clone()));
        }
        let truncated = ranked.len() > limit;
        let items = ranked
            .into_iter()
            .take(limit)
            .map(|ranked| ranked.item)
            .collect();
        let (visited_nodes, visited_edges, iterations) = graph
            .as_ref()
            .map(|result| {
                (
                    result.metrics.visited_nodes,
                    result.metrics.visited_edges,
                    result.metrics.iterations,
                )
            })
            .unwrap_or_default();
        Ok(QueryKnowledgeResult {
            items,
            limit,
            truncated,
            diagnostics: Some(RetrievalDiagnostics {
                mode: if graph.is_some() {
                    RetrievalMode::Hybrid
                } else {
                    RetrievalMode::ExactFallback
                },
                seed_count: seed_ids.len(),
                candidate_case_count: candidate_case_ids.len(),
                visited_nodes,
                visited_edges,
                iterations,
            }),
        })
    }

    fn ensure_retrieval_cache(&self, project_id: &str) -> Result<(), StorageError> {
        let revision: i64 = self.connection.query_row(
            "SELECT coalesce(max(sequence), 0) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;
        if self
            .retrieval_cache
            .borrow()
            .get(project_id)
            .is_some_and(|cached| cached.revision == revision)
        {
            return Ok(());
        }
        let hierarchy = self.load_hierarchy(&ProjectReference {
            project_id: Some(project_id.to_owned()),
            project_root: None,
        })?;
        let mut router = HierarchicalIndex::default();
        for record in hierarchy.routing_records(project_id) {
            router.insert(&record);
        }
        self.retrieval_cache.borrow_mut().insert(
            project_id.to_owned(),
            CachedRetrieval {
                revision,
                router,
                hierarchy,
            },
        );
        Ok(())
    }

    fn eligible_case_ids(
        &self,
        input: &QueryKnowledgeInput,
        project_id: &str,
        case_ids: &[String],
    ) -> Result<BTreeSet<String>, StorageError> {
        if case_ids.is_empty() {
            return Ok(BTreeSet::new());
        }
        let mut values = vec![SqlValue::Text(project_id.to_owned())];
        values.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let mut conditions = vec![format!("cases.id IN ({})", placeholders(case_ids.len()))];
        if let Some(domain) = trimmed(&input.domain) {
            conditions.push("EXISTS (SELECT 1 FROM nodes domain_node WHERE domain_node.case_id = cases.id AND domain_node.type = 'Problem' AND json_extract(domain_node.data, '$.domain') = ?)".into());
            values.push(SqlValue::Text(domain.to_owned()));
        }
        if let Some(file) = trimmed(&input.file) {
            conditions.push("EXISTS (SELECT 1 FROM nodes file_node WHERE file_node.case_id = cases.id AND file_node.data LIKE ?)".into());
            values.push(SqlValue::Text(format!("%{file}%")));
        }
        if let Some(command) = trimmed(&input.command) {
            conditions.push("(EXISTS (SELECT 1 FROM nodes command_node WHERE command_node.case_id = cases.id AND command_node.data LIKE ?) OR EXISTS (SELECT 1 FROM command_runs WHERE command_runs.case_id = cases.id AND command_runs.project_id = cases.project_id AND command_runs.command LIKE ?))".into());
            let pattern = format!("%{command}%");
            values.push(SqlValue::Text(pattern.clone()));
            values.push(SqlValue::Text(pattern));
        }
        if let Some(fingerprint) = trimmed(&input.fingerprint) {
            conditions.push("EXISTS (SELECT 1 FROM fingerprints JOIN nodes problem_node ON problem_node.id = fingerprints.problem_node_id WHERE fingerprints.project_id = cases.project_id AND problem_node.case_id = cases.id AND fingerprints.value = ?)".into());
            values.push(SqlValue::Text(fingerprint.to_owned()));
        }
        let sql = format!(
            "SELECT cases.id FROM cases WHERE cases.project_id = ? AND {} ORDER BY cases.id",
            conditions.join(" AND ")
        );
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(values), |row| row.get(0))?
            .collect::<Result<BTreeSet<String>, _>>()?)
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectWithAliasesRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, description, canonical_root, created_at FROM projects ORDER BY created_at, id",
        )?;
        let projects = statement
            .query_map([], |row| {
                Ok(ProjectRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    root: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        projects
            .into_iter()
            .map(|project| {
                let mut aliases = self.connection.prepare(
                    "SELECT id, project_id, root, created_at FROM project_aliases WHERE project_id = ? ORDER BY created_at, id",
                )?;
                let aliases = aliases
                    .query_map(params![project.id], |row| {
                        Ok(ProjectAliasRecord {
                            id: row.get(0)?,
                            project_id: row.get(1)?,
                            root: row.get(2)?,
                            created_at: row.get(3)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(ProjectWithAliasesRecord { project, aliases })
            })
            .collect()
    }

    pub fn resolve_project_record(
        &self,
        reference: &ProjectReference,
    ) -> Result<ProjectRecord, StorageError> {
        reference.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(reference)?;
        self.connection
            .query_row(
                "SELECT id, name, description, canonical_root, created_at FROM projects WHERE id = ?",
                params![project_id],
                |row| {
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        root: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .map_err(StorageError::from)
    }

    pub fn list_recent_activity(
        &self,
        input: &RecentActivityInput,
    ) -> Result<RecentActivityResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let after_sequence = input.after_sequence.unwrap_or(0);
        let limit = input.limit.unwrap_or(25);
        let mut statement = self.connection.prepare(
            "SELECT sequence, project_id, type, aggregate_id, payload, occurred_at FROM (SELECT sequence, project_id, type, aggregate_id, payload, occurred_at FROM events WHERE project_id = ? AND sequence > ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC",
        )?;
        let mut events = statement
            .query_map(params![project_id, after_sequence, limit + 1], |row| {
                let payload: String = row.get(4)?;
                Ok(KnowledgeEvent {
                    sequence: row.get(0)?,
                    project_id: row.get(1)?,
                    event_type: row.get(2)?,
                    aggregate_id: row.get(3)?,
                    payload: serde_json::from_str(&payload).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    occurred_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let truncated = events.len() > limit;
        if truncated {
            events.remove(0);
        }
        let next_sequence = events.last().map_or(after_sequence, |event| event.sequence);
        Ok(RecentActivityResult {
            events,
            limit,
            truncated,
            next_sequence,
        })
    }

    pub fn list_disk_observations(
        &self,
        input: &ListDiskObservationsInput,
    ) -> Result<ListDiskObservationsResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let limit = input.limit.unwrap_or(25);
        let mut statement = self.connection.prepare(
            "SELECT id,task,status,started_at,finished_at,baseline_tracked_bytes,final_tracked_bytes,delta_bytes,positive_growth_bytes,overlapping_observations,scan_truncated FROM disk_observations WHERE project_id=? ORDER BY COALESCE(finished_at,started_at) DESC,id DESC LIMIT ?",
        )?;
        let mut observations = statement
            .query_map(params![project_id, limit + 1], |row| {
                Ok(DiskObservationSummary {
                    observation_id: row.get(0)?,
                    task: row.get(1)?,
                    status: row.get(2)?,
                    started_at: row.get(3)?,
                    finished_at: row.get(4)?,
                    baseline_tracked_bytes: row.get::<_, i64>(5)? as u64,
                    final_tracked_bytes: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
                    delta_bytes: row.get(7)?,
                    positive_growth_bytes: row.get::<_, Option<i64>>(8)?.map(|value| value as u64),
                    overlapping_observations: row.get::<_, i64>(9)? as usize,
                    scan_truncated: row.get::<_, i64>(10)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let truncated = observations.len() > limit;
        observations.truncate(limit);
        Ok(ListDiskObservationsResult {
            observations,
            limit,
            truncated,
        })
    }

    pub fn load_disk_measurement_cache(
        &self,
        reference: &ProjectReference,
    ) -> Result<Vec<DiskMeasurementCacheEntry>, StorageError> {
        reference.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(reference)?;
        let mut statement = self.connection.prepare(
            "SELECT relative_path,kind,bytes,truncated,directory_stamps FROM disk_measurement_cache WHERE project_id=? ORDER BY relative_path LIMIT 257",
        )?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.len() > 256 {
            return Err(StorageError::InvalidStoredData("disk cache rows"));
        }
        let mut stamp_count = 0_usize;
        let mut entries = Vec::with_capacity(rows.len());
        for (relative_path, kind, bytes, truncated, stamps) in rows {
            if stamps.len() > 16 * 1024 * 1024 {
                return Err(StorageError::InvalidStoredData("disk cache bytes"));
            }
            let directory_stamps: Vec<DiskDirectoryStamp> = serde_json::from_str(&stamps)
                .map_err(|_| StorageError::InvalidStoredData("disk cache stamps"))?;
            stamp_count = stamp_count
                .checked_add(directory_stamps.len())
                .ok_or(StorageError::InvalidStoredData("disk cache bounds"))?;
            if stamp_count > 250_000 {
                return Err(StorageError::InvalidStoredData("disk cache bounds"));
            }
            entries.push(DiskMeasurementCacheEntry {
                relative_path,
                kind: parse_disk_artifact_kind(&kind)
                    .ok_or(StorageError::InvalidStoredData("disk cache kind"))?,
                bytes: u64::try_from(bytes)
                    .map_err(|_| StorageError::InvalidStoredData("disk cache bytes"))?,
                truncated: truncated != 0,
                directory_stamps,
            });
        }
        Ok(entries)
    }

    pub fn list_cleanup_candidates(
        &self,
        input: &ListCleanupCandidatesInput,
    ) -> Result<ListCleanupCandidatesResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let limit = input.limit.unwrap_or(25);
        let mut statement = self.connection.prepare(
            "WITH ranked AS (SELECT entries.observation_id,observations.task,entries.relative_path,entries.kind,entries.delta_bytes,entries.final_bytes,entries.created_by_observation,entries.cleanup_disposition,observations.finished_at,ROW_NUMBER() OVER (PARTITION BY entries.relative_path ORDER BY observations.finished_at DESC,observations.id DESC) AS path_rank FROM disk_observation_entries entries JOIN disk_observations observations ON observations.id=entries.observation_id AND observations.project_id=entries.project_id WHERE entries.project_id=? AND observations.status='completed') SELECT observation_id,task,relative_path,kind,delta_bytes,final_bytes,created_by_observation,cleanup_disposition,finished_at FROM ranked WHERE path_rank=1 AND delta_bytes>0 ORDER BY delta_bytes DESC,relative_path LIMIT ?",
        )?;
        let rows = statement
            .query_map(params![project_id, limit + 1], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut candidates = rows
            .into_iter()
            .map(
                |(
                    observation_id,
                    task,
                    relative_path,
                    kind,
                    growth,
                    final_bytes,
                    created,
                    disposition,
                    finished_at,
                )| {
                    Ok(DiskCleanupCandidate {
                        observation_id,
                        task,
                        relative_path,
                        kind: parse_disk_artifact_kind(&kind)
                            .ok_or(StorageError::InvalidStoredData("disk kind"))?,
                        attributed_growth_bytes: growth as u64,
                        reclaimable_bytes: final_bytes as u64,
                        created_by_observation: created != 0,
                        cleanup_disposition: parse_cleanup_disposition(&disposition)
                            .ok_or(StorageError::InvalidStoredData("cleanup disposition"))?,
                        finished_at,
                    })
                },
            )
            .collect::<Result<Vec<_>, StorageError>>()?;
        let truncated = candidates.len() > limit;
        candidates.truncate(limit);
        Ok(ListCleanupCandidatesResult {
            candidates,
            limit,
            truncated,
        })
    }

    pub fn get_case(&self, input: &GetCaseInput) -> Result<GetCaseResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let (id, title, status, created_at): (String, String, String, String) = self
            .connection
            .query_row(
                "SELECT id, title, status, created_at FROM cases WHERE id = ? AND project_id = ?",
                params![input.case_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or(StorageError::ProjectNotFound)?;
        let status = parse_status(&status).ok_or(StorageError::InvalidStoredData("case status"))?;
        let count = |sql: &str| -> Result<usize, StorageError> {
            Ok(self
                .connection
                .query_row(sql, params![project_id, input.case_id], |row| {
                    row.get::<_, usize>(0)
                })?)
        };
        let counts = CaseCounts {
            nodes: count(
                "SELECT count(*) FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? AND nodes.case_id = ?",
            )?,
            edges: count(
                "SELECT count(*) FROM edges JOIN cases ON cases.id = edges.case_id WHERE cases.project_id = ? AND edges.case_id = ?",
            )?,
            evidence: count(
                "SELECT count(*) FROM evidence JOIN nodes ON nodes.id = evidence.node_id WHERE evidence.project_id = ? AND nodes.case_id = ?",
            )?,
            artifacts: count(
                "SELECT count(*) FROM artifacts LEFT JOIN nodes ON nodes.id = artifacts.node_id WHERE artifacts.project_id = ? AND (nodes.case_id = ? OR artifacts.node_id IS NULL)",
            )?,
            command_runs: count(
                "SELECT count(*) FROM command_runs WHERE project_id = ? AND case_id = ?",
            )?,
            history: count("SELECT count(*) FROM events WHERE project_id = ? AND case_id = ?")?,
        };
        let detail = input.detail.unwrap_or(CaseDetailLevel::Graph);
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut evidence = Vec::new();
        let mut artifacts = Vec::new();
        let mut command_runs = Vec::new();
        if detail != CaseDetailLevel::Summary {
            let mut statement = self.connection.prepare("SELECT id, case_id, type, status, data, created_at FROM nodes WHERE case_id = ? ORDER BY created_at, id LIMIT 1000")?;
            nodes = statement
                .query_map(params![input.case_id], |row| {
                    let node_type: String = row.get(2)?;
                    let status: String = row.get(3)?;
                    let data: String = row.get(4)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        node_type,
                        status,
                        data,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|row| {
                    Ok(NodeRecord {
                        id: row.0,
                        case_id: row.1,
                        node_type: parse_node_type(&row.2)
                            .ok_or(StorageError::InvalidStoredData("node type"))?,
                        status: parse_status(&row.3)
                            .ok_or(StorageError::InvalidStoredData("node status"))?,
                        data: serde_json::from_str(&row.4)
                            .map_err(|_| StorageError::InvalidStoredData("node data"))?,
                        created_at: row.5,
                    })
                })
                .collect::<Result<Vec<_>, StorageError>>()?;
            let mut statement = self.connection.prepare("SELECT id, case_id, source_id, relation, target_id, created_at FROM edges WHERE case_id = ? ORDER BY created_at, id LIMIT 1000")?;
            edges = statement
                .query_map(params![input.case_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|row| {
                    Ok(EdgeRecord {
                        id: row.0,
                        case_id: row.1,
                        source_id: row.2,
                        relation: parse_relation(&row.3)
                            .ok_or(StorageError::InvalidStoredData("edge relation"))?,
                        target_id: row.4,
                        created_at: row.5,
                    })
                })
                .collect::<Result<Vec<_>, StorageError>>()?;
            let mut statement = self.connection.prepare("SELECT evidence.id, evidence.project_id, evidence.node_id, evidence.kind, evidence.command, evidence.exit_status, evidence.data, evidence.created_at FROM evidence JOIN nodes ON nodes.id = evidence.node_id WHERE evidence.project_id = ? AND nodes.case_id = ? ORDER BY evidence.created_at, evidence.id LIMIT 1000")?;
            evidence = statement
                .query_map(params![project_id, input.case_id], |row| {
                    let kind: String = row.get(3)?;
                    let command: Option<String> = row.get(4)?;
                    let data: String = row.get(6)?;
                    Ok(EvidenceRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        node_id: row.get(2)?,
                        kind: if kind == "human" {
                            EvidenceKind::Human
                        } else {
                            EvidenceKind::Automated
                        },
                        command: command
                            .map(|value| serde_json::from_str(&value))
                            .transpose()
                            .map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    4,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?,
                        exit_status: row.get(5)?,
                        data: serde_json::from_str(&data).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        created_at: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = self.connection.prepare("SELECT artifacts.id, artifacts.project_id, artifacts.node_id, artifacts.kind, artifacts.uri, artifacts.digest, artifacts.is_external, artifacts.metadata, artifacts.created_at FROM artifacts LEFT JOIN nodes ON nodes.id = artifacts.node_id WHERE artifacts.project_id = ? AND (nodes.case_id = ? OR artifacts.node_id IS NULL) ORDER BY artifacts.created_at, artifacts.id LIMIT 1000")?;
            artifacts = statement
                .query_map(params![project_id, input.case_id], |row| {
                    let metadata: String = row.get(7)?;
                    Ok(ArtifactRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        node_id: row.get(2)?,
                        kind: row.get(3)?,
                        uri: row.get(4)?,
                        digest: row.get(5)?,
                        is_external: row.get::<_, i64>(6)? == 1,
                        metadata: serde_json::from_str(&metadata).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                7,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        created_at: row.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = self.connection.prepare("SELECT id, project_id, case_id, attempt_node_id, command, working_directory, exit_status, signal, duration_ms, excerpt, raw_log_path, raw_log_digest, started_at, finished_at FROM command_runs WHERE project_id = ? AND case_id = ? ORDER BY started_at, id LIMIT 1000")?;
            command_runs = statement
                .query_map(params![project_id, input.case_id], |row| {
                    let command: String = row.get(4)?;
                    Ok(CommandRunRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        case_id: row.get(2)?,
                        attempt_id: row.get(3)?,
                        command: serde_json::from_str(&command).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                4,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        working_directory: row.get(5)?,
                        exit_status: row.get(6)?,
                        signal: row.get(7)?,
                        duration_ms: row.get(8)?,
                        excerpt: row.get(9)?,
                        raw_log_path: row.get(10)?,
                        raw_log_digest: row.get(11)?,
                        started_at: row.get(12)?,
                        finished_at: row.get(13)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
        }
        let mut history = Vec::new();
        let mut history_next_before_sequence = None;
        if detail == CaseDetailLevel::Full {
            let history_limit = input.history_limit.unwrap_or(50);
            // SQLite INTEGER values are signed 64-bit. An absent or larger unsigned
            // cursor means "before every persisted event", so cap it to the largest
            // representable database sequence before binding.
            let before = input
                .history_before_sequence
                .unwrap_or(i64::MAX as u64)
                .min(i64::MAX as u64);
            let mut statement = self.connection.prepare("SELECT sequence, project_id, type, aggregate_id, payload, occurred_at FROM events WHERE project_id = ? AND case_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?")?;
            history = statement
                .query_map(
                    params![project_id, input.case_id, before, history_limit + 1],
                    |row| {
                        let payload: String = row.get(4)?;
                        Ok(KnowledgeEvent {
                            sequence: row.get(0)?,
                            project_id: row.get(1)?,
                            event_type: row.get(2)?,
                            aggregate_id: row.get(3)?,
                            payload: serde_json::from_str(&payload).map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    4,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?,
                            occurred_at: row.get(5)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            if history.len() > history_limit {
                history.pop();
                history_next_before_sequence = history.last().map(|event| event.sequence);
            }
            history.reverse();
        }
        Ok(GetCaseResult {
            id,
            project_id,
            title,
            status,
            created_at,
            nodes,
            edges,
            detail,
            counts,
            evidence,
            artifacts,
            command_runs,
            history,
            history_next_before_sequence,
        })
    }

    pub fn import_preview_path_hints(
        &self,
        project: &ProjectReference,
        preview_id: &str,
    ) -> Result<Vec<String>, StorageError> {
        project.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(project)?;
        let manifest: String = self
            .connection
            .query_row(
                "SELECT source_manifest FROM import_previews WHERE id = ? AND project_id = ?",
                params![preview_id, project_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StorageError::ProjectNotFound)?;
        let manifests: Vec<Value> = serde_json::from_str(&manifest)
            .map_err(|_| StorageError::InvalidStoredData("import source manifest"))?;
        manifests
            .into_iter()
            .map(|value| {
                value
                    .get("pathHint")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or(StorageError::InvalidStoredData("import source path hint"))
            })
            .collect()
    }

    pub fn load_hierarchy(
        &self,
        project: &ProjectReference,
    ) -> Result<KnowledgeHierarchy, StorageError> {
        project.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(project)?;
        let revision: i64 = self.connection.query_row(
            "SELECT coalesce(max(sequence), 0) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;
        let mut builders = BTreeMap::<String, HierarchyBuilder>::new();
        let mut statement = self.connection.prepare(
            "SELECT cases.id, cases.title, cases.status, nodes.type, nodes.status, nodes.data FROM cases LEFT JOIN nodes ON nodes.case_id = cases.id WHERE cases.project_id = ? ORDER BY cases.id, nodes.created_at, nodes.id",
        )?;
        let rows = statement.query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            let (case_id, title, case_status, node_type, node_status, data_text) = row?;
            let builder = builders
                .entry(case_id.clone())
                .or_insert_with(|| HierarchyBuilder {
                    case_id,
                    status: parse_status(&case_status).unwrap_or(NodeStatus::Candidate),
                    domain: "general".into(),
                    text_parts: vec![title],
                    ..HierarchyBuilder::default()
                });
            if let (Some(node_type), Some(node_status), Some(data_text)) =
                (node_type, node_status, data_text)
            {
                let data: Value = serde_json::from_str(&data_text)
                    .map_err(|_| StorageError::InvalidStoredData("node data"))?;
                builder.text_parts.push(data_text);
                if node_type == "Problem" {
                    if let Some(domain) = data.get("domain").and_then(Value::as_str) {
                        builder.domain = domain.to_owned();
                    }
                }
                collect_structural_values(&data, &mut builder.files, &mut builder.commands);
                if node_status == "verified"
                    && matches!(node_type.as_str(), "RootCause" | "Solution")
                {
                    builder.verified_conclusion = data
                        .get("summary")
                        .or_else(|| data.get("explanation"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or(builder.verified_conclusion.take());
                }
            }
        }
        let mut statement = self.connection.prepare(
            "SELECT nodes.case_id, fingerprints.value FROM fingerprints JOIN nodes ON nodes.id = fingerprints.problem_node_id JOIN cases ON cases.id = nodes.case_id WHERE fingerprints.project_id = ? AND cases.project_id = ?",
        )?;
        for row in statement.query_map(params![project_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (case_id, fingerprint) = row?;
            if let Some(builder) = builders.get_mut(&case_id) {
                builder.fingerprints.insert(fingerprint);
            }
        }
        let mut statement = self.connection.prepare(
            "SELECT case_id, command FROM command_runs WHERE project_id = ? AND case_id IS NOT NULL",
        )?;
        for row in statement.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (case_id, command_text) = row?;
            if let Some(builder) = builders.get_mut(&case_id) {
                let command = serde_json::from_str::<Vec<String>>(&command_text)
                    .unwrap_or_default()
                    .join(" ");
                if !command.is_empty() {
                    builder.commands.insert(command);
                }
            }
        }
        let records = builders
            .into_values()
            .map(|builder| builder.record(&project_id))
            .collect::<Vec<_>>();
        let edges = structural_edges(&records);
        Ok(KnowledgeHierarchy::build(revision, records, edges))
    }

    pub fn expand_case_graph(
        &self,
        project: &ProjectReference,
        case_ids: &[String],
        exact_node_ids: &[String],
        semantic_scores: &[(String, u16)],
        config: ExpansionConfig,
    ) -> Result<ExpansionResult, StorageError> {
        project.validate().map_err(StorageError::Contract)?;
        if case_ids.is_empty() || case_ids.len() > 100 || exact_node_ids.is_empty() {
            return Err(StorageError::Contract(ErrorCode::InvalidArgument));
        }
        let project_id = self.resolve_project(project)?;
        let exact = exact_node_ids.iter().collect::<BTreeSet<_>>();
        let semantic = semantic_scores.iter().cloned().collect::<BTreeMap<_, _>>();
        let mut parameters = vec![SqlValue::Text(project_id.clone())];
        parameters.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let node_sql = format!(
            "SELECT nodes.id, nodes.type, nodes.status FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? AND cases.id IN ({}) ORDER BY nodes.id",
            placeholders(case_ids.len())
        );
        let mut statement = self.connection.prepare(&node_sql)?;
        let nodes = statement
            .query_map(params_from_iter(parameters), |row| {
                let node_id = row.get::<_, String>(0)?;
                let node_type_text = row.get::<_, String>(1)?;
                let status_text = row.get::<_, String>(2)?;
                Ok((node_id, node_type_text, status_text))
            })?
            .map(|row| {
                let (node_id, node_type_text, status_text) = row?;
                Ok(ExpansionNode {
                    project_id: project_id.clone(),
                    exact_score: u32::from(exact.contains(&node_id)),
                    semantic_score: semantic.get(&node_id).copied(),
                    node_id,
                    node_type: parse_node_type(&node_type_text)
                        .ok_or(StorageError::InvalidStoredData("node type"))?,
                    status: parse_status(&status_text)
                        .ok_or(StorageError::InvalidStoredData("node status"))?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;

        let mut parameters = vec![SqlValue::Text(project_id.clone())];
        parameters.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let edge_sql = format!(
            "SELECT edges.source_id, edges.relation, edges.target_id FROM edges JOIN cases ON cases.id = edges.case_id WHERE cases.project_id = ? AND cases.id IN ({}) ORDER BY edges.source_id, edges.relation, edges.target_id",
            placeholders(case_ids.len())
        );
        let mut statement = self.connection.prepare(&edge_sql)?;
        let edges = statement
            .query_map(params_from_iter(parameters), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .map(|row| {
                let (source_id, relation, target_id) = row?;
                Ok(ExpansionEdge {
                    source_id,
                    relation: parse_relation(&relation)
                        .ok_or(StorageError::InvalidStoredData("edge relation"))?,
                    target_id,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;

        expand_bounded(&project_id, exact_node_ids, &nodes, &edges, config)
            .map_err(|_| StorageError::Contract(ErrorCode::InvalidArgument))
    }

    pub fn preflight(&self, input: &PreflightInput) -> Result<PreflightResult, StorageError> {
        Ok(self.preflight_with_metrics(input)?.result)
    }

    pub fn preflight_with_metrics(
        &self,
        input: &PreflightInput,
    ) -> Result<PreflightExecution, StorageError> {
        let started = Instant::now();
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let revision: i64 = self.connection.query_row(
            "SELECT coalesce(max(sequence), 0) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;
        let key = format!(
            "{project_id}:{revision}:{}",
            serde_json::to_string(input)
                .map_err(|_| StorageError::InvalidStoredData("preflight input"))?,
        );
        if let Some(cached) = self.preflight_cache.borrow().get(&key).cloned() {
            return Ok(PreflightExecution {
                metrics: PreflightMetrics {
                    cache_hit: true,
                    candidate_count: cached.candidate_count,
                    card_count: cached.result.cards.len(),
                    execution_micros: started.elapsed().as_micros(),
                },
                result: cached.result,
            });
        }
        let (result, candidate_count) = self.build_preflight(input, &project_id)?;
        self.remember_preflight(
            key,
            CachedPreflight {
                result: result.clone(),
                candidate_count,
            },
        );
        Ok(PreflightExecution {
            metrics: PreflightMetrics {
                cache_hit: false,
                candidate_count,
                card_count: result.cards.len(),
                execution_micros: started.elapsed().as_micros(),
            },
            result,
        })
    }

    fn build_preflight(
        &self,
        input: &PreflightInput,
        project_id: &str,
    ) -> Result<(PreflightResult, usize), StorageError> {
        let limit = input.limit.unwrap_or(5).min(5);
        let context_text = format!(
            "{} {} {} {}",
            input.task_description,
            input.changed_files.as_deref().unwrap_or_default().join(" "),
            input.command.as_deref().unwrap_or_default().join(" "),
            input.fingerprint.as_deref().unwrap_or_default(),
        );
        let candidate_case_ids = self.candidate_case_ids(project_id, &context_text)?;
        let fingerprint_case_ids = if let Some(fingerprint) = trimmed(&input.fingerprint) {
            let mut statement = self.connection.prepare(
                "SELECT DISTINCT nodes.case_id FROM fingerprints JOIN nodes ON nodes.id = fingerprints.problem_node_id JOIN cases ON cases.id = nodes.case_id WHERE fingerprints.project_id = ? AND cases.project_id = ? AND fingerprints.value = ?",
            )?;
            statement
                .query_map(params![project_id, project_id, fingerprint], |row| {
                    row.get(0)
                })?
                .collect::<Result<Vec<String>, _>>()?
        } else {
            Vec::new()
        };
        let mut nodes = self.nodes_for_cases(project_id, &candidate_case_ids)?;
        let mut guardrails = Vec::<PreflightGuardrail>::new();
        let mut statement = self.connection.prepare(
            "SELECT nodes.id, nodes.case_id, nodes.type, nodes.status, nodes.data, nodes.created_at, guardrails.enforcement, guardrails.criteria FROM guardrails JOIN nodes ON nodes.id = guardrails.node_id JOIN cases ON cases.id = nodes.case_id WHERE guardrails.project_id = ? AND cases.project_id = ? ORDER BY nodes.created_at DESC",
        )?;
        let rows = statement.query_map(params![project_id, project_id], |row| {
            let node = node_from_columns(row, 0)?;
            let enforcement: String = row.get(6)?;
            let criteria_text: String = row.get(7)?;
            Ok((node, enforcement, criteria_text))
        })?;
        for row in rows {
            let (node, enforcement, criteria_text) = row?;
            let criteria_value: Value = serde_json::from_str(&criteria_text)
                .map_err(|_| StorageError::InvalidStoredData("guardrail criteria"))?;
            let criteria = guardrail_criteria(&criteria_value);
            let command_text = input.command.as_deref().unwrap_or_default().join(" ");
            let file_text = input
                .changed_files
                .as_deref()
                .unwrap_or_default()
                .join("\n");
            let enforcement = match enforcement.as_str() {
                "advise" => GuardrailEnforcement::Advise,
                "warn" => GuardrailEnforcement::Warn,
                "block" => GuardrailEnforcement::Block,
                _ => return Err(StorageError::InvalidStoredData("guardrail enforcement")),
            };
            let evaluation = evaluate_guardrail(
                &criteria,
                node.status,
                enforcement,
                GuardrailContext {
                    task: &input.task_description,
                    command: &command_text,
                    files: &file_text,
                },
            );
            if evaluation.matches {
                if !nodes.iter().any(|candidate| candidate.id == node.id) {
                    nodes.push(node.clone());
                }
                guardrails.push(PreflightGuardrail {
                    node,
                    blocks: evaluation.blocks,
                });
            }
        }
        guardrails.sort_by(|left, right| {
            right
                .blocks
                .cmp(&left.blocks)
                .then_with(|| left.node.id.cmp(&right.node.id))
        });
        let mut case_ids = nodes
            .iter()
            .map(|node| node.case_id.clone())
            .collect::<Vec<_>>();
        case_ids.extend(
            guardrails
                .iter()
                .map(|guardrail| guardrail.node.case_id.clone()),
        );
        case_ids.sort();
        case_ids.dedup();
        let case_rows = self.case_rows(project_id, &case_ids)?;
        let candidates = case_rows
            .into_iter()
            .map(|(case_id, case_title, case_status)| RelevanceCandidate {
                nodes: nodes
                    .iter()
                    .filter(|node| node.case_id == case_id)
                    .cloned()
                    .collect(),
                guardrails: guardrails
                    .iter()
                    .filter(|item| item.node.case_id == case_id)
                    .cloned()
                    .collect(),
                case_id,
                case_title,
                case_status,
            })
            .collect();
        let now_epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as i64);
        let cards = rank_cases(
            &RelevanceContext {
                task_description: input.task_description.clone(),
                changed_files: input.changed_files.clone().unwrap_or_default(),
                command: input.command.clone().unwrap_or_default(),
                fingerprint_case_ids,
                now_epoch_ms,
            },
            candidates,
        )
        .into_iter()
        .take(limit)
        .collect();
        let uncertain = nodes
            .iter()
            .filter(|node| {
                matches!(node.status, NodeStatus::Open | NodeStatus::Candidate)
                    && node.node_type != NodeType::Attempt
            })
            .take(limit)
            .cloned()
            .collect();
        let result = compact_preflight(
            PreflightResult {
                blocked: guardrails.iter().any(|guardrail| guardrail.blocks),
                cards,
                guardrails: vec![],
                failed_attempts: vec![],
                root_causes: vec![],
                solutions: vec![],
                uncertain,
                truncated: false,
                expansion_case_ids: vec![],
            },
            12 * 1024,
        );
        Ok((result, case_ids.len()))
    }

    fn remember_preflight(&self, key: String, value: CachedPreflight) {
        let mut cache = self.preflight_cache.borrow_mut();
        let mut order = self.preflight_order.borrow_mut();
        cache.insert(key.clone(), value);
        order.push_back(key);
        while order.len() > 256 {
            if let Some(oldest) = order.pop_front() {
                cache.remove(&oldest);
            }
        }
    }

    fn candidate_case_ids(
        &self,
        project_id: &str,
        context: &str,
    ) -> Result<Vec<String>, StorageError> {
        let Some(query) = build_fts_query_with_join(context, " OR ") else {
            return Ok(Vec::new());
        };
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT nodes.case_id FROM node_search JOIN nodes ON nodes.id = node_search.node_id JOIN cases ON cases.id = nodes.case_id WHERE node_search MATCH ? AND cases.project_id = ? LIMIT 1000",
        )?;
        Ok(statement
            .query_map(params![query, project_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?)
    }

    fn nodes_for_cases(
        &self,
        project_id: &str,
        case_ids: &[String],
    ) -> Result<Vec<NodeRecord>, StorageError> {
        if case_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT nodes.id, nodes.case_id, nodes.type, nodes.status, nodes.data, nodes.created_at FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? AND nodes.case_id IN ({}) ORDER BY nodes.created_at DESC LIMIT 10000",
            placeholders(case_ids.len()),
        );
        let mut values = vec![SqlValue::Text(project_id.to_owned())];
        values.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(values), |row| node_from_columns(row, 0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    fn case_rows(
        &self,
        project_id: &str,
        case_ids: &[String],
    ) -> Result<Vec<(String, String, NodeStatus)>, StorageError> {
        if case_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT id, title, status FROM cases WHERE project_id = ? AND id IN ({})",
            placeholders(case_ids.len())
        );
        let mut values = vec![SqlValue::Text(project_id.to_owned())];
        values.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(values), |row| {
                let status_text: String = row.get(2)?;
                let status = parse_status(&status_text).ok_or_else(|| {
                    rusqlite::Error::InvalidColumnType(
                        2,
                        "status".into(),
                        rusqlite::types::Type::Text,
                    )
                })?;
                Ok((row.get(0)?, row.get(1)?, status))
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    fn resolve_project(&self, input: &ProjectReference) -> Result<String, StorageError> {
        let found = if let Some(project_id) = &input.project_id {
            self.connection
                .query_row(
                    "SELECT id FROM projects WHERE id = ?",
                    params![project_id],
                    |row| row.get(0),
                )
                .optional()?
        } else if let Some(root) = &input.project_root {
            let root = std::fs::canonicalize(root)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| root.to_owned());
            self.connection.query_row(
                "SELECT id FROM projects WHERE canonical_root = ? UNION SELECT projects.id FROM project_aliases JOIN projects ON projects.id = project_aliases.project_id WHERE project_aliases.root = ? LIMIT 1",
                params![root, root], |row| row.get(0),
            ).optional()?
        } else {
            None
        };
        found.ok_or(StorageError::ProjectNotFound)
    }
}

fn append_route_reasons(
    item: &mut KnowledgeQueryItem,
    route: Option<&RouteHit>,
    shell: Option<&(String, usize, String)>,
    hierarchy_match: bool,
    requested_domain: Option<&str>,
) {
    if let Some(route) = route {
        if route.domain_scoped {
            push_reason(
                &mut item.why_matched,
                RetrievalMatchKind::DomainRoute,
                requested_domain.unwrap_or("project-domain"),
            );
        }
        push_reason(
            &mut item.why_matched,
            RetrievalMatchKind::PrefixRoute,
            &route.matched_routes.join(","),
        );
    }
    if let Some((_, _, component)) = shell.filter(|(_, level, _)| *level > 0) {
        push_reason(
            &mut item.why_matched,
            RetrievalMatchKind::KShellCommunity,
            component,
        );
    } else if hierarchy_match {
        push_reason(
            &mut item.why_matched,
            RetrievalMatchKind::KShellCommunity,
            "structural-community",
        );
    }
}

fn parse_disk_artifact_kind(value: &str) -> Option<DiskArtifactKind> {
    match value {
        "build-cache" => Some(DiskArtifactKind::BuildCache),
        "dependency-cache" => Some(DiskArtifactKind::DependencyCache),
        "generated-output" => Some(DiskArtifactKind::GeneratedOutput),
        "temporary-output" => Some(DiskArtifactKind::TemporaryOutput),
        _ => None,
    }
}

fn parse_cleanup_disposition(value: &str) -> Option<CleanupDisposition> {
    match value {
        "eligible" => Some(CleanupDisposition::Eligible),
        "review" => Some(CleanupDisposition::Review),
        "shared" => Some(CleanupDisposition::Shared),
        _ => None,
    }
}

fn push_reason(reasons: &mut Vec<RetrievalReason>, kind: RetrievalMatchKind, value: &str) {
    if reasons.len() >= 8 || reasons.iter().any(|reason| reason.kind == kind) {
        return;
    }
    reasons.push(RetrievalReason {
        kind,
        value: bounded_reason(value),
    });
}

fn insert_ranked(items: &mut BTreeMap<String, RankedQueryItem>, mut candidate: RankedQueryItem) {
    let node_id = candidate.item.node.id.clone();
    if let Some(existing) = items.get_mut(&node_id) {
        for reason in candidate.item.why_matched.drain(..) {
            push_reason(&mut existing.item.why_matched, reason.kind, &reason.value);
        }
        if existing.item.supporting_path.is_empty() {
            existing.item.supporting_path = candidate.item.supporting_path;
        }
        existing.score = existing.score.max(candidate.score);
    } else {
        items.insert(node_id, candidate);
    }
}

fn node_matches_output_filters(node: &NodeRecord, input: &QueryKnowledgeInput) -> bool {
    input
        .node_types
        .as_deref()
        .is_none_or(|types| types.is_empty() || types.contains(&node.node_type))
        && input
            .statuses
            .as_deref()
            .is_none_or(|statuses| statuses.is_empty() || statuses.contains(&node.status))
}

fn node_overlap(node: &NodeRecord, terms: &[String]) -> usize {
    if terms.is_empty() {
        return 0;
    }
    let searchable = serde_json::to_string(&node.data)
        .unwrap_or_default()
        .to_lowercase();
    terms
        .iter()
        .filter(|term| searchable.contains(term.as_str()))
        .count()
}

fn retrieval_terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for token in text
        .split(|character: char| {
            !(character.is_alphanumeric() || matches!(character, '_' | '.' | '-'))
        })
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
    {
        if token.chars().count() >= 3 && token.chars().all(is_han) {
            let characters = token.chars().collect::<Vec<_>>();
            terms.extend(
                characters
                    .windows(2)
                    .map(|pair| pair.iter().collect::<String>()),
            );
        }
        if !terms.contains(&token) {
            terms.push(token);
        }
    }
    terms
}

fn is_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn bounded_reason(value: &str) -> String {
    value.chars().take(256).collect()
}

fn exact_reasons(input: &QueryKnowledgeInput) -> Vec<RetrievalReason> {
    let mut reasons = Vec::new();
    for (kind, value) in [
        (RetrievalMatchKind::ExactText, trimmed(&input.text)),
        (
            RetrievalMatchKind::ExactFingerprint,
            trimmed(&input.fingerprint),
        ),
        (RetrievalMatchKind::ExactFile, trimmed(&input.file)),
        (RetrievalMatchKind::ExactCommand, trimmed(&input.command)),
    ] {
        if let Some(value) = value {
            push_reason(&mut reasons, kind, value);
        }
    }
    reasons
}

fn build_fts_query(text: &str) -> Option<String> {
    build_fts_query_with_join(text, " AND ")
}

fn build_fts_query_with_join(text: &str, joiner: &str) -> Option<String> {
    let mut terms = Vec::<String>::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '.' | '-') {
            current.push(character);
        } else if !current.is_empty() {
            push_term(&mut terms, std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        push_term(&mut terms, current);
    }
    if terms.is_empty() {
        None
    } else {
        Some(
            terms
                .into_iter()
                .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(joiner),
        )
    }
}

fn node_from_columns(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<NodeRecord> {
    let data_text: String = row.get(offset + 4)?;
    let data = serde_json::from_str::<BTreeMap<String, Value>>(&data_text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset + 4,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let node_type_text: String = row.get(offset + 2)?;
    let status_text: String = row.get(offset + 3)?;
    let node_type = parse_node_type(&node_type_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(offset + 2, "type".into(), rusqlite::types::Type::Text)
    })?;
    let status = parse_status(&status_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(offset + 3, "status".into(), rusqlite::types::Type::Text)
    })?;
    Ok(NodeRecord {
        id: row.get(offset)?,
        case_id: row.get(offset + 1)?,
        node_type,
        status,
        data,
        created_at: row.get(offset + 5)?,
    })
}

fn guardrail_criteria(value: &Value) -> GuardrailCriteria {
    GuardrailCriteria {
        task_includes_all: value_strings(value, "taskIncludes"),
        task_includes_any: value_strings(value, "taskIncludesAny"),
        command_includes_all: value_strings(value, "commandIncludes"),
        command_includes_any: value_strings(value, "commandIncludesAny"),
        file_includes_all: value_strings(value, "fileIncludes"),
        file_includes_any: value_strings(value, "fileIncludesAny"),
    }
}

fn value_strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

struct HierarchyBuilder {
    case_id: String,
    status: NodeStatus,
    domain: String,
    text_parts: Vec<String>,
    fingerprints: BTreeSet<String>,
    files: BTreeSet<String>,
    commands: BTreeSet<String>,
    verified_conclusion: Option<String>,
}

impl Default for HierarchyBuilder {
    fn default() -> Self {
        Self {
            case_id: String::new(),
            status: NodeStatus::Candidate,
            domain: "general".into(),
            text_parts: Vec::new(),
            fingerprints: BTreeSet::new(),
            files: BTreeSet::new(),
            commands: BTreeSet::new(),
            verified_conclusion: None,
        }
    }
}

impl HierarchyBuilder {
    fn record(self, project_id: &str) -> HierarchyRecord {
        HierarchyRecord {
            project_id: project_id.to_owned(),
            domain: self.domain,
            case_id: self.case_id,
            status: self.status,
            text: self.text_parts.join(" "),
            fingerprints: self.fingerprints.into_iter().collect(),
            files: self.files.into_iter().collect(),
            commands: self.commands.into_iter().collect(),
            verified_conclusion: self.verified_conclusion,
        }
    }
}

fn collect_structural_values(
    value: &Value,
    files: &mut BTreeSet<String>,
    commands: &mut BTreeSet<String>,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, item) in object {
        let target = if key.to_ascii_lowercase().contains("file") {
            Some(&mut *files)
        } else if key.to_ascii_lowercase().contains("command") {
            Some(&mut *commands)
        } else {
            None
        };
        if let Some(target) = target {
            if let Some(text) = item.as_str() {
                target.insert(text.to_owned());
            }
            if let Some(items) = item.as_array() {
                target.extend(items.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
    }
}

fn structural_edges(records: &[HierarchyRecord]) -> Vec<HierarchyEdge> {
    const MAX_CASES_PER_KEY: usize = 64;
    let mut buckets = BTreeMap::<(String, u8, String), Vec<String>>::new();
    for record in records {
        for (kind, values) in [
            (0, &record.fingerprints),
            (1, &record.files),
            (2, &record.commands),
        ] {
            for value in values {
                buckets
                    .entry((record.domain.clone(), kind, value.clone()))
                    .or_default()
                    .push(record.case_id.clone());
            }
        }
    }
    let mut pairs = BTreeSet::<(String, String)>::new();
    for mut case_ids in buckets.into_values() {
        case_ids.sort();
        case_ids.dedup();
        // Very broad keys are weak evidence and can create quadratic cliques.
        // Excluding them keeps hierarchy rebuilds bounded while retaining
        // discriminative structural communities for k-shell routing.
        if case_ids.len() > MAX_CASES_PER_KEY {
            continue;
        }
        for left in 0..case_ids.len() {
            for right in (left + 1)..case_ids.len() {
                pairs.insert((case_ids[left].clone(), case_ids[right].clone()));
            }
        }
    }
    pairs
        .into_iter()
        .map(|(left, right)| HierarchyEdge::new(&left, &right))
        .collect()
}

fn push_term(terms: &mut Vec<String>, term: String) {
    if !matches!(
        term.to_ascii_uppercase().as_str(),
        "AND" | "OR" | "NOT" | "NEAR"
    ) && !terms.contains(&term)
    {
        terms.push(term);
    }
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}
fn retain_first_per_case(items: &mut Vec<KnowledgeQueryItem>) {
    let mut cases = BTreeSet::new();
    items.retain(|item| cases.insert(item.case_id.clone()));
}
fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}
fn node_type_text(value: NodeType) -> &'static str {
    match value {
        NodeType::Problem => "Problem",
        NodeType::Attempt => "Attempt",
        NodeType::RootCause => "RootCause",
        NodeType::Solution => "Solution",
        NodeType::Verification => "Verification",
        NodeType::SuccessCase => "SuccessCase",
        NodeType::Guardrail => "Guardrail",
        NodeType::Artifact => "Artifact",
    }
}
fn status_text(value: NodeStatus) -> &'static str {
    match value {
        NodeStatus::Open => "open",
        NodeStatus::Candidate => "candidate",
        NodeStatus::Verified => "verified",
        NodeStatus::Regressed => "regressed",
        NodeStatus::Retired => "retired",
    }
}
fn parse_node_type(value: &str) -> Option<NodeType> {
    Some(match value {
        "Problem" => NodeType::Problem,
        "Attempt" => NodeType::Attempt,
        "RootCause" => NodeType::RootCause,
        "Solution" => NodeType::Solution,
        "Verification" => NodeType::Verification,
        "SuccessCase" => NodeType::SuccessCase,
        "Guardrail" => NodeType::Guardrail,
        "Artifact" => NodeType::Artifact,
        _ => return None,
    })
}
fn parse_status(value: &str) -> Option<NodeStatus> {
    Some(match value {
        "open" => NodeStatus::Open,
        "candidate" => NodeStatus::Candidate,
        "verified" => NodeStatus::Verified,
        "regressed" => NodeStatus::Regressed,
        "retired" => NodeStatus::Retired,
        _ => return None,
    })
}

fn parse_relation(value: &str) -> Option<RelationType> {
    match value {
        "ATTEMPTS_TO_SOLVE" => Some(RelationType::AttemptsToSolve),
        "PRECEDED_BY" => Some(RelationType::PrecededBy),
        "FAILED_BECAUSE" => Some(RelationType::FailedBecause),
        "CAUSES" => Some(RelationType::Causes),
        "ADDRESSES" => Some(RelationType::Addresses),
        "VERIFIED_BY" => Some(RelationType::VerifiedBy),
        "REFERENCES" => Some(RelationType::References),
        "INCLUDES" => Some(RelationType::Includes),
        "PREVENTS" => Some(RelationType::Prevents),
        "SUPERSEDES" => Some(RelationType::Supersedes),
        _ => None,
    }
}
