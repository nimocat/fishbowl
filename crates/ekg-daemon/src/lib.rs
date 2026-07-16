use std::collections::BTreeMap;
use std::time::Instant;

use ekg_core::{HierarchicalIndex, KnowledgeRecord};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

pub mod protocol;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub request_id: String,
    pub project_id: String,
    pub text: String,
    pub domain: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub request_id: String,
    pub case_ids: Vec<String>,
    pub revision: i64,
    pub cache_hit: bool,
    pub execution_micros: u128,
}

struct CachedProject {
    revision: i64,
    index: HierarchicalIndex,
}

/// Read-only migration seam. Rust owns SQLite reads and candidate routing;
/// TypeScript remains a protocol adapter until the Rust daemon owns writes.
pub struct RetrievalEngine {
    connection: Connection,
    projects: BTreeMap<String, CachedProject>,
}

impl RetrievalEngine {
    pub fn open(database_path: &str) -> rusqlite::Result<Self> {
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "query_only", true)?;
        Ok(Self {
            connection,
            projects: BTreeMap::new(),
        })
    }

    pub fn query(&mut self, request: QueryRequest) -> rusqlite::Result<QueryResponse> {
        let started = Instant::now();
        let revision = self.project_revision(&request.project_id)?;
        let cache_hit = self
            .projects
            .get(&request.project_id)
            .is_some_and(|cached| cached.revision == revision);
        if !cache_hit {
            let index = self.load_project(&request.project_id)?;
            self.projects.insert(
                request.project_id.clone(),
                CachedProject { revision, index },
            );
        }
        let case_ids = self.projects[&request.project_id].index.search(
            &request.text,
            request.domain.as_deref(),
            request.limit,
        );
        Ok(QueryResponse {
            request_id: request.request_id,
            case_ids,
            revision,
            cache_hit,
            execution_micros: started.elapsed().as_micros(),
        })
    }

    fn project_revision(&self, project_id: &str) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT coalesce(max(sequence), 0) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )
    }

    fn load_project(&self, project_id: &str) -> rusqlite::Result<HierarchicalIndex> {
        let mut statement = self.connection.prepare(
            "WITH case_domains AS (
                 SELECT case_id,
                        coalesce(max(json_extract(data, '$.domain')), 'general') AS domain
                 FROM nodes
                 WHERE type = 'Problem'
                 GROUP BY case_id
             )
             SELECT nodes.case_id, nodes.data, coalesce(case_domains.domain, 'general') AS domain
             FROM nodes
             JOIN cases ON cases.id = nodes.case_id
             LEFT JOIN case_domains ON case_domains.case_id = nodes.case_id
             WHERE cases.project_id = ?",
        )?;
        let records = statement.query_map(params![project_id], |row| {
            Ok(KnowledgeRecord {
                case_id: row.get(0)?,
                text: row.get(1)?,
                domain: row.get(2)?,
            })
        })?;
        let mut index = HierarchicalIndex::default();
        for record in records {
            index.insert(&record?);
        }
        Ok(index)
    }
}
