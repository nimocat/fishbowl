export class ProjectNotFoundError extends Error {
  constructor(reference: string) {
    super(`Project not found: ${reference}`)
    this.name = 'ProjectNotFoundError'
  }
}

export class AmbiguousProjectReferenceError extends Error {
  constructor(message = 'Provide a project ID or project root that resolves to one project') {
    super(message)
    this.name = 'AmbiguousProjectReferenceError'
  }
}

export class ProjectConflictError extends Error {
  constructor(root: string) {
    super(`Project root is already registered: ${root}`)
    this.name = 'ProjectConflictError'
  }
}

export class CaseNotFoundError extends Error {
  constructor(caseId: string) {
    super(`Case not found in project: ${caseId}`)
    this.name = 'CaseNotFoundError'
  }
}

export class InvalidGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidGraphError'
  }
}
