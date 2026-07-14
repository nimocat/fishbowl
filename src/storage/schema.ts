export const schemaVersion = 6

const coreSchema = `
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

const platformSchema = `
  CREATE TABLE IF NOT EXISTS command_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT,
    attempt_node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
    command TEXT NOT NULL CHECK (json_valid(command)),
    working_directory TEXT NOT NULL,
    exit_status INTEGER,
    signal TEXT,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    excerpt TEXT NOT NULL,
    raw_log_path TEXT,
    raw_log_digest TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS command_runs_project_started_idx
  ON command_runs(project_id, started_at);

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    node_id TEXT UNIQUE REFERENCES nodes(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    uri TEXT NOT NULL CHECK (length(trim(uri)) > 0),
    digest TEXT,
    is_external INTEGER NOT NULL DEFAULT 0 CHECK (is_external IN (0, 1)),
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS artifacts_project_id_idx ON artifacts(project_id);

  CREATE TABLE IF NOT EXISTS import_previews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    source_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'stale')),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    UNIQUE(project_id, id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS import_previews_project_created_idx
  ON import_previews(project_id, created_at);

  CREATE TABLE IF NOT EXISTS import_proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    preview_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    node_type TEXT NOT NULL CHECK (node_type IN ('Problem', 'Attempt', 'RootCause', 'Solution', 'Verification', 'SuccessCase', 'Guardrail', 'Artifact')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, preview_id, source_key),
    FOREIGN KEY (project_id, preview_id)
      REFERENCES import_previews(project_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS import_proposals_project_preview_idx
  ON import_proposals(project_id, preview_id);

  CREATE TABLE IF NOT EXISTS source_keys (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    source_kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, source_kind, source_key)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS source_keys_project_node_idx
  ON source_keys(project_id, node_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS node_search USING fts5(
    project_id UNINDEXED,
    node_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
  );
`

const serviceSchema = `
  CREATE TABLE IF NOT EXISTS operation_results (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result)),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, operation_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS operation_results_project_id_idx
  ON operation_results(project_id, operation_id);
`

const importSchema = `
  ALTER TABLE import_previews ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE import_previews ADD COLUMN source_manifest TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_manifest));
  ALTER TABLE import_previews ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
`

const ownershipSchema = `
  CREATE TRIGGER evidence_project_ownership_insert BEFORE INSERT ON evidence
  WHEN NOT EXISTS (
    SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id
    WHERE nodes.id = NEW.node_id AND cases.project_id = NEW.project_id
  ) BEGIN SELECT RAISE(ABORT, 'evidence project ownership mismatch'); END;

  CREATE TRIGGER fingerprints_project_ownership_insert BEFORE INSERT ON fingerprints
  WHEN NOT EXISTS (
    SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id
    WHERE nodes.id = NEW.problem_node_id AND nodes.type = 'Problem' AND cases.project_id = NEW.project_id
  ) BEGIN SELECT RAISE(ABORT, 'fingerprint project ownership mismatch'); END;

  CREATE TRIGGER guardrails_project_ownership_insert BEFORE INSERT ON guardrails
  WHEN NOT EXISTS (
    SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id
    WHERE nodes.id = NEW.node_id AND nodes.type = 'Guardrail' AND cases.project_id = NEW.project_id
  ) BEGIN SELECT RAISE(ABORT, 'guardrail project ownership mismatch'); END;

  CREATE TRIGGER artifacts_project_ownership_insert BEFORE INSERT ON artifacts
  WHEN NEW.node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id
    WHERE nodes.id = NEW.node_id AND nodes.type = 'Artifact' AND cases.project_id = NEW.project_id
  ) BEGIN SELECT RAISE(ABORT, 'artifact project ownership mismatch'); END;

  CREATE TRIGGER command_runs_project_ownership_insert BEFORE INSERT ON command_runs
  WHEN (NEW.case_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cases WHERE id = NEW.case_id AND project_id = NEW.project_id
    )) OR (NEW.attempt_node_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id
      WHERE nodes.id = NEW.attempt_node_id AND nodes.type = 'Attempt'
        AND cases.project_id = NEW.project_id AND (NEW.case_id IS NULL OR nodes.case_id = NEW.case_id)
    ))
  BEGIN SELECT RAISE(ABORT, 'command run project ownership mismatch'); END;

  CREATE TRIGGER source_keys_project_ownership_insert BEFORE INSERT ON source_keys
  WHEN NOT EXISTS (
    SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id
    WHERE nodes.id = NEW.node_id AND cases.project_id = NEW.project_id
  ) BEGIN SELECT RAISE(ABORT, 'source key project ownership mismatch'); END;

  CREATE TRIGGER evidence_project_ownership_update BEFORE UPDATE OF project_id, node_id ON evidence
  WHEN NOT EXISTS (SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = NEW.node_id AND cases.project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'evidence project ownership mismatch'); END;
  CREATE TRIGGER fingerprints_project_ownership_update BEFORE UPDATE OF project_id, problem_node_id ON fingerprints
  WHEN NOT EXISTS (SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = NEW.problem_node_id AND nodes.type = 'Problem' AND cases.project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'fingerprint project ownership mismatch'); END;
  CREATE TRIGGER guardrails_project_ownership_update BEFORE UPDATE OF project_id, node_id ON guardrails
  WHEN NOT EXISTS (SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = NEW.node_id AND nodes.type = 'Guardrail' AND cases.project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'guardrail project ownership mismatch'); END;
  CREATE TRIGGER artifacts_project_ownership_update BEFORE UPDATE OF project_id, node_id ON artifacts
  WHEN NEW.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = NEW.node_id AND nodes.type = 'Artifact' AND cases.project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'artifact project ownership mismatch'); END;
  CREATE TRIGGER command_runs_project_ownership_update BEFORE UPDATE OF project_id, case_id, attempt_node_id ON command_runs
  WHEN (NEW.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cases WHERE id = NEW.case_id AND project_id = NEW.project_id))
    OR (NEW.attempt_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = NEW.attempt_node_id AND nodes.type = 'Attempt' AND cases.project_id = NEW.project_id AND (NEW.case_id IS NULL OR nodes.case_id = NEW.case_id)))
  BEGIN SELECT RAISE(ABORT, 'command run project ownership mismatch'); END;
  CREATE TRIGGER source_keys_project_ownership_update BEFORE UPDATE OF project_id, node_id ON source_keys
  WHEN NOT EXISTS (SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = NEW.node_id AND cases.project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'source key project ownership mismatch'); END;
`

const efficiencySchema = `
  DROP TRIGGER events_reject_update;

  ALTER TABLE events ADD COLUMN case_id TEXT REFERENCES cases(id) ON DELETE RESTRICT;

  UPDATE events
  SET case_id = CASE
    WHEN EXISTS (
      SELECT 1 FROM cases
      WHERE cases.id = events.aggregate_id
        AND cases.project_id = events.project_id
    ) THEN aggregate_id
    ELSE json_extract(payload, '$.caseId')
  END
  WHERE case_id IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM cases
        WHERE cases.id = events.aggregate_id
          AND cases.project_id = events.project_id
      )
      OR EXISTS (
        SELECT 1 FROM cases
        WHERE cases.id = json_extract(events.payload, '$.caseId')
          AND cases.project_id = events.project_id
      )
    );

  CREATE INDEX events_project_case_sequence_idx
  ON events(project_id, case_id, sequence);

  CREATE INDEX edges_case_source_idx ON edges(case_id, source_id);
  CREATE INDEX edges_case_target_idx ON edges(case_id, target_id);

  CREATE TRIGGER events_case_ownership_insert BEFORE INSERT ON events
  WHEN NEW.case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cases
    WHERE cases.id = NEW.case_id AND cases.project_id = NEW.project_id
  )
  BEGIN SELECT RAISE(ABORT, 'event case project ownership mismatch'); END;

  CREATE TRIGGER events_reject_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;
`

export const schemaMigrations = [
  coreSchema,
  platformSchema,
  serviceSchema,
  importSchema,
  ownershipSchema,
  efficiencySchema,
] as const

export const schema = schemaMigrations.join('\n')
