const NODE_TYPES = ['Problem', 'Attempt', 'RootCause', 'Solution', 'Verification', 'Artifact', 'Guardrail', 'SuccessCase']
const STATUSES = ['open', 'candidate', 'verified', 'regressed']
const TYPE_COLUMNS = new Map(NODE_TYPES.map((type, index) => [type, index]))

const state = {
  projects: [],
  projectId: '',
  graph: null,
  caseDetail: null,
  selectedNodeId: '',
  query: '',
  types: new Set(),
  statuses: new Set(),
  domain: '',
  confidence: 0,
  activities: [],
  eventSource: null,
  requestController: null,
  caseRequestController: null,
  selectionToken: 0,
  cursor: 0,
  view: 'loading',
}

const elements = Object.fromEntries([
  'project-select', 'search-form', 'search-input', 'type-filters', 'status-filters',
  'view-state', 'case-results', 'result-count', 'case-state', 'edge-layer', 'node-layer',
  'semantic-trace', 'attempt-timeline', 'inspector-content', 'activity-list', 'live-dot',
  'live-status', 'reconnect-button', 'evidence-inspector', 'domain-filter', 'confidence-filter',
].map((id) => [id, document.getElementById(id)]))

function scopedParams(extra = {}) {
  const params = new URLSearchParams(extra)
  params.set('project_id', state.projectId)
  return params
}

async function readJson(path, signal) {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    throw new Error(detail.message || `Read failed (${response.status})`)
  }
  return response.json()
}

function setConnection(label, kind = '') {
  elements['live-status'].textContent = label
  elements['live-dot'].className = `live-dot ${kind}`
}

function setView(view, message = '') {
  state.view = view
  elements['view-state'].className = `view-state ${view}`
  elements['view-state'].textContent = message
}

function buildFilters(container, values, selected, onChange) {
  container.replaceChildren(...values.map((value) => {
    const label = document.createElement('label')
    label.className = 'filter-chip'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = value
    input.checked = selected.has(value)
    input.addEventListener('change', () => {
      input.checked ? selected.add(value) : selected.delete(value)
      onChange()
    })
    const text = document.createElement('span')
    text.textContent = value
    label.append(input, text)
    return label
  }))
}

async function loadProjects() {
  const result = await readJson('/api/v1/projects')
  state.projects = result.projects
  elements['project-select'].replaceChildren(...state.projects.map((project) => {
    const option = document.createElement('option')
    option.value = project.id
    option.textContent = project.name
    return option
  }))
  if (!state.projects.length) {
    state.view = 'empty'
    setView('empty', 'No projects are registered. Use the CLI or MCP server to register one.')
    renderEmptyWorkspace()
    return
  }
  state.projectId = state.projects[0].id
  await loadGraph()
}

async function loadGraph(preferredCaseId = '') {
  if (!state.projectId) return
  const projectId = state.projectId
  state.requestController?.abort()
  state.caseRequestController?.abort()
  const controller = new AbortController()
  state.requestController = controller
  setView('loading', 'Reading the current project...')
  const extra = {}
  if (state.query) extra.q = state.query
  if (state.types.size) extra.types = [...state.types].join(',')
  if (state.statuses.size) extra.statuses = [...state.statuses].join(',')
  if (state.domain) extra.domain = state.domain
  try {
    const result = await readJson(`/api/v1/graph?${scopedParams(extra)}`, controller.signal)
    if (projectId !== state.projectId) return
    if (state.confidence > 0) {
      result.cases = result.cases.filter((item) => item.nodes.some((node) =>
        node.type === 'RootCause' && Number(node.data.confidence || 0) >= state.confidence))
    }
    state.graph = result
    state.cursor = Math.max(state.cursor, result.asOfSequence || 0)
    renderCaseResults()
    if (!result.cases.length) {
      state.view = 'empty'
      state.caseDetail = null
      setView('empty', state.query || state.types.size || state.statuses.size
        ? 'No Cases match the current search and filters.'
        : 'This project has no Cases yet.')
      renderEmptyWorkspace()
    } else {
      const selected = result.cases.find((item) => item.id === preferredCaseId)
        || result.cases.find((item) => item.id === state.caseDetail?.id)
        || result.cases[0]
      await selectCase(selected.id, false, projectId, controller.signal)
      setView('ready', result.truncated ? 'Showing a bounded snapshot. Refine the search to narrow it.' : '')
    }
    await loadActivity(projectId, controller.signal)
    connectEvents()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (projectId !== state.projectId) return
    state.view = 'error'
    setView('error', error instanceof Error ? error.message : 'The project snapshot could not be read.')
    renderEmptyWorkspace()
  }
}

async function loadActivity(projectId = state.projectId, signal) {
  const result = await readJson(`/api/v1/activity?${scopedParams({ after: '0', limit: '30' })}`, signal)
  if (projectId !== state.projectId) return
  state.activities = result.events.slice().reverse()
  renderActivity()
}

function renderCaseResults() {
  const cases = state.graph?.cases || []
  elements['result-count'].textContent = `${cases.length}${state.graph?.truncated ? '+' : ''} Cases`
  elements['case-results'].replaceChildren(...cases.map((caseItem) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'case-card'
    button.setAttribute('aria-pressed', String(caseItem.id === state.caseDetail?.id))
    const title = document.createElement('strong')
    title.textContent = caseItem.title
    const detail = document.createElement('small')
    detail.textContent = `${caseItem.status} · ${caseItem.nodes.length} nodes`
    button.append(title, detail)
    button.addEventListener('click', () => selectCase(caseItem.id))
    return button
  }))
}

async function selectCase(caseId, focusInspector = true, projectId = state.projectId, signal) {
  state.caseRequestController?.abort()
  const controller = new AbortController()
  state.caseRequestController = controller
  const selectionToken = ++state.selectionToken
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const params = scopedParams()
    params.set('history_limit', '50')
    const result = await readJson(`/api/v1/cases/${encodeURIComponent(caseId)}?${params}`, controller.signal)
    if (projectId !== state.projectId || selectionToken !== state.selectionToken) return
    state.caseDetail = result
    state.cursor = Math.max(state.cursor, result.asOfSequence || 0)
    if (!result.nodes.some((node) => node.id === state.selectedNodeId)) {
      state.selectedNodeId = result.nodes[0]?.id || ''
    }
    renderCaseResults()
    renderCase()
    if (focusInspector) elements['evidence-inspector'].focus()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (projectId !== state.projectId || selectionToken !== state.selectionToken) return
    state.view = 'error'
    setView('error', error instanceof Error ? error.message : 'The Case could not be read.')
  }
}

function renderCase() {
  const caseDetail = state.caseDetail
  if (!caseDetail) return renderEmptyWorkspace()
  elements['case-state'].textContent = caseDetail.status
  elements['case-state'].className = `status-stamp ${caseDetail.status}`
  if (caseDetail.status === 'regressed') {
    setView('regression', 'Regression: prior evidence remains available while this Case is investigated again.')
  }
  renderGraph(caseDetail)
  renderSemanticTrace(caseDetail)
  renderTimeline(caseDetail)
  renderInspector(caseDetail.nodes.find((node) => node.id === state.selectedNodeId))
}

function nodeSummary(node) {
  return node.data.summary || node.data.hypothesis || node.data.explanation || node.data.change || node.data.uri || node.type
}

function graphPosition(node, index, siblings) {
  const column = TYPE_COLUMNS.get(node.type) ?? 0
  const x = 90 + column * 105
  const siblingIndex = siblings.findIndex((candidate) => candidate.id === node.id)
  const y = 65 + siblingIndex * 95 + (index % 2) * 8
  return { x, y }
}

function renderGraph(caseDetail) {
  const byType = new Map()
  for (const node of caseDetail.nodes) {
    const siblings = byType.get(node.type) || []
    siblings.push(node)
    byType.set(node.type, siblings)
  }
  const positions = new Map(caseDetail.nodes.map((node, index) => [
    node.id,
    graphPosition(node, index, byType.get(node.type)),
  ]))
  elements['node-layer'].replaceChildren(...caseDetail.nodes.map((node) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `graph-node ${node.status}${node.id === state.selectedNodeId ? ' selected' : ''}`
    button.style.left = `${positions.get(node.id).x}px`
    button.style.top = `${positions.get(node.id).y}px`
    button.setAttribute('aria-label', `${node.type}, ${node.status}: ${nodeSummary(node)}`)
    const type = document.createElement('strong')
    type.textContent = `${node.type} · ${node.status}`
    const summary = document.createElement('span')
    summary.textContent = String(nodeSummary(node))
    button.append(type, summary)
    button.addEventListener('click', () => selectNode(node.id))
    return button
  }))
  const svgNamespace = 'http://www.w3.org/2000/svg'
  elements['edge-layer'].replaceChildren(...caseDetail.edges.flatMap((edge) => {
    const source = positions.get(edge.sourceId)
    const target = positions.get(edge.targetId)
    if (!source || !target) return []
    const line = document.createElementNS(svgNamespace, 'line')
    line.setAttribute('x1', String(source.x))
    line.setAttribute('y1', String(source.y))
    line.setAttribute('x2', String(target.x))
    line.setAttribute('y2', String(target.y))
    const label = document.createElementNS(svgNamespace, 'text')
    label.setAttribute('x', String((source.x + target.x) / 2))
    label.setAttribute('y', String((source.y + target.y) / 2 - 5))
    label.textContent = edge.relation
    return [line, label]
  }))
}

function renderSemanticTrace(caseDetail) {
  const outgoing = new Map()
  for (const edge of caseDetail.edges) {
    const relations = outgoing.get(edge.sourceId) || []
    relations.push(`${edge.relation} ${caseDetail.nodes.find((node) => node.id === edge.targetId)?.type || 'node'}`)
    outgoing.set(edge.sourceId, relations)
  }
  elements['semantic-trace'].replaceChildren(...caseDetail.nodes.map((node) => {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'trace-button'
    button.setAttribute('aria-current', String(node.id === state.selectedNodeId))
    const heading = document.createElement('strong')
    heading.textContent = `${node.type} · ${node.status}`
    const summary = document.createElement('span')
    summary.textContent = ` ${nodeSummary(node)}`
    const relation = document.createElement('span')
    relation.className = 'trace-relation'
    relation.textContent = outgoing.get(node.id)?.join(' / ') || 'No outgoing relation'
    button.append(heading, summary, relation)
    button.addEventListener('click', () => selectNode(node.id))
    item.append(button)
    return item
  }))
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId
  renderCase()
  elements['evidence-inspector'].focus()
}

function renderTimeline(caseDetail) {
  const attemptNodes = caseDetail.nodes.filter((node) => node.type === 'Attempt')
  const predecessor = new Map(caseDetail.edges
    .filter((edge) => edge.relation === 'PRECEDED_BY')
    .map((edge) => [edge.sourceId, edge.targetId]))
  const targets = new Set(predecessor.values())
  const newest = attemptNodes.find((node) => !targets.has(node.id))
  const orderedIds = []
  for (let id = newest?.id; id; id = predecessor.get(id)) orderedIds.unshift(id)
  const attempts = [
    ...orderedIds.map((id) => attemptNodes.find((node) => node.id === id)).filter(Boolean),
    ...attemptNodes.filter((node) => !orderedIds.includes(node.id)),
  ]
  elements['attempt-timeline'].replaceChildren(...(attempts.length ? attempts.map((node, index) => {
    const item = document.createElement('li')
    const title = document.createElement('strong')
    title.textContent = `${index + 1}. ${node.data.hypothesis || 'Attempt'}`
    const outcome = document.createElement('small')
    outcome.textContent = `${node.data.outcome || node.status} · ${node.data.decisiveDifference || node.data.failureExplanation || 'No outcome detail'}`
    item.append(title, outcome)
    return item
  }) : [emptyItem('No Attempts in this Case.')]))
}

function renderInspector(node) {
  if (!node || !state.caseDetail) {
    elements['inspector-content'].replaceChildren(emptyParagraph('Select a node to inspect its evidence.'))
    return
  }
  const list = document.createElement('dl')
  const entries = [
    ['Type', node.type], ['Status', node.status], ['ID', node.id],
    ...Object.entries(node.data).map(([key, value]) => [key, formatValue(value)]),
  ]
  for (const [key, value] of entries) {
    const term = document.createElement('dt')
    term.textContent = key
    const description = document.createElement('dd')
    description.textContent = String(value)
    list.append(term, description)
  }
  const evidence = state.caseDetail.evidence.filter((item) => item.nodeId === node.id)
  const artifacts = state.caseDetail.artifacts.filter((item) => item.nodeId === node.id)
  const commands = state.caseDetail.commandRuns.filter((item) => item.attemptId === node.id)
  const heading = document.createElement('h3')
  heading.textContent = 'Attached evidence'
  const supporting = document.createElement('p')
  supporting.textContent = evidence.length || artifacts.length || commands.length
    ? `${evidence.length} evidence items · ${artifacts.length} artifacts · ${commands.length} commands`
    : 'No attached evidence for this node.'
  const details = document.createElement('pre')
  details.textContent = JSON.stringify({
    evidence: evidence.slice(0, 20), artifacts: artifacts.slice(0, 20), commandRuns: commands.slice(0, 20),
  }, null, 2).slice(0, 32_000)
  elements['inspector-content'].replaceChildren(list, heading, supporting, details)
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join('\n')
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2)
  return value ?? ''
}

function renderActivity() {
  elements['activity-list'].replaceChildren(...(state.activities.length ? state.activities.map((event) => {
    const item = document.createElement('li')
    const type = document.createElement('strong')
    type.textContent = event.type
    const time = document.createElement('time')
    time.dateTime = event.occurredAt
    time.textContent = new Date(event.occurredAt).toLocaleTimeString()
    item.append(type, time)
    return item
  }) : [emptyItem('Waiting for project activity.')]))
}

function renderEmptyWorkspace() {
  elements['case-results'].replaceChildren()
  elements['node-layer'].replaceChildren()
  elements['edge-layer'].replaceChildren()
  elements['semantic-trace'].replaceChildren(emptyItem('No trace to display.'))
  elements['attempt-timeline'].replaceChildren(emptyItem('No Attempt timeline to display.'))
  elements['inspector-content'].replaceChildren(emptyParagraph('No evidence to inspect.'))
  elements['case-state'].textContent = ''
}

function emptyItem(text) {
  const item = document.createElement('li')
  item.className = 'empty-copy'
  item.textContent = text
  return item
}

function emptyParagraph(text) {
  const paragraph = document.createElement('p')
  paragraph.className = 'empty-copy'
  paragraph.textContent = text
  return paragraph
}

function connectEvents(force = false) {
  if (!state.projectId) return
  if (state.eventSource) state.eventSource.close()
  if (force) setConnection('Reconnecting')
  const projectId = state.projectId
  const source = new EventSource(`/api/v1/events?${scopedParams({ after: String(state.cursor) })}`)
  state.eventSource = source
  source.onopen = () => setConnection('Live', 'connected')
  source.onerror = () => setConnection('Reconnecting', 'error')
  source.addEventListener('knowledge_event', async (message) => {
    if (projectId !== state.projectId || source !== state.eventSource) return
    const event = JSON.parse(message.data)
    if (event.sequence <= state.cursor) return
    state.cursor = event.sequence
    state.activities.unshift(event)
    state.activities = state.activities.slice(0, 30)
    renderActivity()
    const activeCaseId = state.caseDetail?.id
    await loadGraph(activeCaseId)
  })
  source.addEventListener('snapshot_required', async (message) => {
    if (projectId !== state.projectId || source !== state.eventSource) return
    const notice = JSON.parse(message.data)
    state.cursor = Math.max(state.cursor, notice.asOfSequence || Number(message.lastEventId) || 0)
    setView('loading', 'Live history exceeded the event window. Reading a fresh snapshot...')
    await loadGraph(state.caseDetail?.id)
  })
  source.addEventListener('stream_error', () => {
    state.view = 'error'
    setView('error', 'Live activity paused because the event journal could not be read.')
  })
}

elements['project-select'].addEventListener('change', async (event) => {
  if (state.eventSource) state.eventSource.close()
  state.eventSource = null
  state.requestController?.abort()
  state.caseRequestController?.abort()
  state.projectId = event.target.value
  state.cursor = 0
  state.caseDetail = null
  state.activities = []
  renderActivity()
  await loadGraph()
})
elements['search-form'].addEventListener('submit', async (event) => {
  event.preventDefault()
  state.query = elements['search-input'].value.trim()
  await loadGraph()
})
elements['reconnect-button'].addEventListener('click', () => connectEvents(true))
elements['domain-filter'].addEventListener('change', async (event) => {
  state.domain = event.target.value.trim()
  await loadGraph()
})
elements['confidence-filter'].addEventListener('change', async (event) => {
  state.confidence = Number(event.target.value)
  await loadGraph()
})

buildFilters(elements['type-filters'], NODE_TYPES, state.types, () => loadGraph())
buildFilters(elements['status-filters'], STATUSES, state.statuses, () => loadGraph())
renderActivity()
loadProjects().catch((error) => {
  state.view = 'error'
  setView('error', error instanceof Error ? error.message : 'Trace Bench could not start.')
  setConnection('Offline', 'error')
})
