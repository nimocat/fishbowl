export const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    canonical_root TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS project_aliases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    root TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    status TEXT NOT NULL CHECK (status IN ('open', 'candidate', 'verified', 'regressed', 'retired')),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS cases_project_id_idx ON cases(project_id);

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CHECK (type IN ('Problem', 'Attempt', 'RootCause', 'Solution', 'Verification', 'SuccessCase', 'Guardrail', 'Artifact')),
    status TEXT NOT NULL CHECK (status IN ('open', 'candidate', 'verified', 'regressed', 'retired')),
    data TEXT NOT NULL CHECK (json_valid(data)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS nodes_case_id_idx ON nodes(case_id);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    relation TEXT NOT NULL,
    target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE(case_id, source_id, relation, target_id),
    CHECK (source_id <> target_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS edges_case_id_idx ON edges(case_id);

  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('automated', 'human')),
    command TEXT,
    exit_status INTEGER,
    data TEXT NOT NULL CHECK (json_valid(data)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS evidence_project_node_idx ON evidence(project_id, node_id);

  CREATE TABLE IF NOT EXISTS fingerprints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    problem_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    algorithm TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, algorithm, value)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS guardrails (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE RESTRICT,
    enforcement TEXT NOT NULL CHECK (enforcement IN ('advise', 'warn', 'block')),
    criteria TEXT NOT NULL CHECK (json_valid(criteria)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS guardrails_project_id_idx ON guardrails(project_id);

  CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CHECK (length(trim(type)) > 0),
    aggregate_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS events_project_sequence_idx ON events(project_id, sequence);

  CREATE TRIGGER IF NOT EXISTS events_reject_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS events_reject_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;
`
