import type Database from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import {
  AmbiguousProjectReferenceError,
  ProjectConflictError,
  ProjectNotFoundError,
} from '../domain/errors.js'

interface ProjectRow {
  id: string
  name: string
  description: string | null
  canonical_root: string
  created_at: string
}

interface AliasRow {
  id: string
  project_id: string
  root: string
  created_at: string
}

export interface Project {
  id: string
  name: string
  description: string | null
  root: string
  createdAt: string
}

export interface ProjectAlias {
  id: string
  projectId: string
  root: string
  createdAt: string
}

export interface ProjectWithAliases extends Project {
  aliases: ProjectAlias[]
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    root: row.canonical_root,
    createdAt: row.created_at,
  }
}

function toAlias(row: AliasRow): ProjectAlias {
  return {
    id: row.id,
    projectId: row.project_id,
    root: row.root,
    createdAt: row.created_at,
  }
}

export class ProjectRegistry {
  constructor(private readonly database: Database.Database) {}

  register(input: { name: string; root: string; description?: string }): Project {
    const root = realpathSync(input.root)
    const project: Project = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      root,
      createdAt: new Date().toISOString(),
    }

    return this.database.transaction(() => {
      this.assertRootAvailable(root)
      this.database
        .prepare(
          `INSERT INTO projects (id, name, description, canonical_root, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(project.id, project.name, project.description, project.root, project.createdAt)
      this.appendEvent(project.id, 'project.registered', project.id, project)
      return project
    })()
  }

  addAlias(projectId: string, inputRoot: string): ProjectAlias {
    const root = realpathSync(inputRoot)
    const project = this.findById(projectId)
    if (!project) {
      throw new ProjectNotFoundError(projectId)
    }

    const alias: ProjectAlias = {
      id: randomUUID(),
      projectId,
      root,
      createdAt: new Date().toISOString(),
    }

    return this.database.transaction(() => {
      this.assertRootAvailable(root)
      this.database
        .prepare(
          `INSERT INTO project_aliases (id, project_id, root, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(alias.id, alias.projectId, alias.root, alias.createdAt)
      this.appendEvent(projectId, 'project.alias_added', alias.id, alias)
      return alias
    })()
  }

  list(): ProjectWithAliases[] {
    const projects = this.database
      .prepare('SELECT * FROM projects ORDER BY created_at, id')
      .all() as ProjectRow[]
    const aliases = this.database
      .prepare('SELECT * FROM project_aliases ORDER BY created_at, id')
      .all() as AliasRow[]

    return projects.map((row) => {
      const project = toProject(row)
      return {
        ...project,
        aliases: aliases
          .filter((alias) => alias.project_id === project.id)
          .map(toAlias),
      }
    })
  }

  resolve(reference: { projectId?: string; projectRoot?: string }): Project {
    if (!reference.projectId && !reference.projectRoot) {
      throw new AmbiguousProjectReferenceError()
    }

    const byId = reference.projectId ? this.findById(reference.projectId) : undefined
    const byRoot = reference.projectRoot
      ? this.findByRoot(realpathSync(reference.projectRoot))
      : undefined

    if (reference.projectId && !byId) {
      throw new ProjectNotFoundError(reference.projectId)
    }
    if (reference.projectRoot && !byRoot) {
      throw new ProjectNotFoundError(reference.projectRoot)
    }
    if (byId && byRoot && byId.id !== byRoot.id) {
      throw new AmbiguousProjectReferenceError(
        'Project ID and project root resolve to different projects',
      )
    }

    return byId ?? (byRoot as Project)
  }

  private findById(projectId: string): Project | undefined {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined
    return row ? toProject(row) : undefined
  }

  private findByRoot(root: string): Project | undefined {
    const row = this.database
      .prepare(
        `SELECT DISTINCT projects.*
         FROM projects
         LEFT JOIN project_aliases ON project_aliases.project_id = projects.id
         WHERE projects.canonical_root = ? OR project_aliases.root = ?`,
      )
      .get(root, root) as ProjectRow | undefined
    return row ? toProject(row) : undefined
  }

  private assertRootAvailable(root: string): void {
    if (this.findByRoot(root)) {
      throw new ProjectConflictError(root)
    }
  }

  private appendEvent(
    projectId: string,
    type: string,
    aggregateId: string,
    payload: unknown,
  ): void {
    this.database
      .prepare(
        `INSERT INTO events (project_id, type, aggregate_id, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, type, aggregateId, JSON.stringify(payload), new Date().toISOString())
  }
}
