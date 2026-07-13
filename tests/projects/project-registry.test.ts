import type Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AmbiguousProjectReferenceError,
  ProjectConflictError,
  ProjectNotFoundError,
} from '../../src/domain/errors.js'
import { ProjectRegistry } from '../../src/projects/project-registry.js'
import { closeDatabase, openDatabase } from '../../src/storage/database.js'

describe('ProjectRegistry', () => {
  let database: Database.Database
  let registry: ProjectRegistry
  let sandbox: string

  beforeEach(() => {
    database = openDatabase(':memory:')
    registry = new ProjectRegistry(database)
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-projects-'))
  })

  afterEach(() => {
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  })

  function createRoot(name: string): string {
    const root = join(sandbox, name)
    mkdirSync(root)
    return root
  }

  it('registers a canonical project root and appends an event', () => {
    const root = createRoot('project')

    const project = registry.register({ name: 'Example', root })
    const events = database.prepare('SELECT project_id, type FROM events').all()

    expect(project).toMatchObject({
      name: 'Example',
      description: null,
      root: realpathSync(root),
    })
    expect(project.id).toEqual(expect.any(String))
    expect(events).toEqual([
      { project_id: project.id, type: 'project.registered' },
    ])
    expect(registry.list()).toEqual([{ ...project, aliases: [] }])
  })

  it('rejects a canonical root already owned by a project', () => {
    const root = createRoot('project')
    registry.register({ name: 'First', root })

    expect(() => registry.register({ name: 'Second', root })).toThrow(
      ProjectConflictError,
    )
  })

  it('rolls back materialized state when appending its event fails', () => {
    const root = createRoot('project')
    database.exec(`
      CREATE TRIGGER reject_project_events
      BEFORE INSERT ON events
      WHEN NEW.type = 'project.registered'
      BEGIN
        SELECT RAISE(ABORT, 'simulated event failure');
      END;
    `)

    expect(() => registry.register({ name: 'Example', root })).toThrow(
      /simulated event failure/,
    )
    expect(database.prepare('SELECT * FROM projects').all()).toEqual([])
    expect(database.prepare('SELECT * FROM events').all()).toEqual([])
  })

  it('adds aliases transactionally and resolves IDs, roots, and aliases', () => {
    const root = createRoot('project')
    const aliasRoot = createRoot('worktree')
    const project = registry.register({ name: 'Example', root })

    const alias = registry.addAlias(project.id, aliasRoot)

    expect(alias).toMatchObject({
      projectId: project.id,
      root: realpathSync(aliasRoot),
    })
    expect(registry.resolve({ projectId: project.id })).toEqual(project)
    expect(registry.resolve({ projectRoot: root })).toEqual(project)
    expect(registry.resolve({ projectRoot: aliasRoot })).toEqual(project)
    expect(registry.resolve({ projectId: project.id, projectRoot: aliasRoot })).toEqual(
      project,
    )
    expect(registry.list()[0]?.aliases).toEqual([alias])
    expect(
      database.prepare('SELECT type FROM events ORDER BY sequence').all(),
    ).toEqual([
      { type: 'project.registered' },
      { type: 'project.alias_added' },
    ])
  })

  it('rejects absent and conflicting project references', () => {
    const first = registry.register({ name: 'First', root: createRoot('first') })
    const secondRoot = createRoot('second')
    registry.register({ name: 'Second', root: secondRoot })

    expect(() => registry.resolve({})).toThrow(AmbiguousProjectReferenceError)
    expect(() =>
      registry.resolve({ projectId: first.id, projectRoot: secondRoot }),
    ).toThrow(AmbiguousProjectReferenceError)
    expect(() => registry.resolve({ projectId: 'missing' })).toThrow(
      ProjectNotFoundError,
    )
  })

  it('rejects aliases owned by another project or used as canonical roots', () => {
    const sharedRoot = createRoot('shared')
    const first = registry.register({ name: 'First', root: createRoot('first') })
    const second = registry.register({ name: 'Second', root: createRoot('second') })
    registry.addAlias(first.id, sharedRoot)

    expect(() => registry.addAlias(second.id, sharedRoot)).toThrow(
      ProjectConflictError,
    )
    expect(() => registry.addAlias(first.id, second.root)).toThrow(
      ProjectConflictError,
    )
  })
})
