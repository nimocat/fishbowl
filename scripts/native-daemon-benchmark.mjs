import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = mkdtempSync(join(tmpdir(), 'ekg-native-bench-'))
const projectRoot = join(root, 'project')
mkdirSync(projectRoot)
const token = 'native-benchmark-token'
const tokenFile = join(root, 'daemon.token')
const descriptorFile = join(root, 'daemon.json')
writeFileSync(tokenFile, token, { mode: 0o600 })
const executable = join('dist', 'native', process.platform === 'win32' ? 'ekg-rust-core.exe' : 'ekg-rust-core')
const child = spawn(executable, [
  'daemon', '--database', join(root, 'knowledge.db'), '--token-file', tokenFile,
  '--descriptor', descriptorFile, '--pid-file', join(root, 'daemon.pid'), '--port', '0',
], { stdio: 'ignore' })

try {
  const descriptor = await waitDescriptor()
  const call = (operation, input, requestId = randomUUID()) => rpc(descriptor.port, {
    protocolVersion: 1, requestId, operation, input,
  })
  const registered = await call('registerProject', {
    name: 'Native Benchmark', root: projectRoot, operationId: randomUUID(),
  })
  const project = { projectId: registered.body.result.id }
  await call('recordProblem', {
    project, operationId: randomUUID(), caseTitle: 'Benchmark retrieval',
    data: { summary: 'Measure native daemon preflight and checkpoint', domain: 'performance' },
  })
  await call('preflight', { project, taskDescription: 'Measure native daemon performance', limit: 5 })

  const warm = []
  const transport = []
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now()
    const response = await call('listProjects', {})
    const total = performance.now() - started
    warm.push(total)
    transport.push(Math.max(0, response.totalMs - Object.values(response.timing).reduce((sum, value) => sum + value, 0)))
  }

  const preflightExecution = []
  for (let index = 0; index < 100; index += 1) {
    const response = await call('preflight', {
      project, taskDescription: 'Measure native daemon performance', limit: 5,
    })
    preflightExecution.push(response.timing.execution ?? Number.POSITIVE_INFINITY)
  }

  const checkpoint = []
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now()
    await call('checkpointWork', {
      project, operationId: randomUUID(), task: `Bounded checkpoint ${index}`,
      outcome: 'failed', summary: `Synthetic bounded failure ${index}`,
    })
    checkpoint.push(performance.now() - started)
  }

  const metrics = {
    fixture: 'native-daemon-release-v1',
    warmRpcP95Ms: p95(warm),
    checkpointP95Ms: p95(checkpoint),
    daemonPreflightExecutionP95Ms: p95(preflightExecution),
    clientTransportP95Ms: p95(transport),
    samples: { warmRpc: warm.length, checkpoint: checkpoint.length, preflight: preflightExecution.length },
  }
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`)
  if (metrics.warmRpcP95Ms >= 250) throw new Error('warm RPC p95 exceeded 250ms')
  if (metrics.checkpointP95Ms >= 300) throw new Error('checkpoint p95 exceeded 300ms')
  if (metrics.daemonPreflightExecutionP95Ms >= 100) throw new Error('daemon preflight p95 exceeded 100ms')
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  rmSync(root, { recursive: true, force: true })
}

async function waitDescriptor() {
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    try {
      const value = JSON.parse(readFileSync(descriptorFile, 'utf8'))
      if (Number.isInteger(value.port) && value.port > 0) return value
    } catch { /* bounded startup poll */ }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('native daemon did not publish a descriptor')
}

function rpc(port, body) {
  const encoded = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const outgoing = request({
      hostname: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', 'Content-Length': encoded.byteLength,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value.ok) return reject(new Error(`${value.error?.code}: ${value.error?.message}`))
        resolve({ body: value, totalMs: performance.now() - started, timing: parseTiming(response.headers['server-timing']) })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(encoded)
  })
}

function parseTiming(value) {
  const result = {}
  for (const item of String(value || '').split(',')) {
    const match = /\s*([a-z]+);dur=([0-9.]+)/.exec(item)
    if (match) result[match[1]] = Number(match[2])
  }
  return result
}

function p95(values) {
  const ordered = values.slice().sort((left, right) => left - right)
  return Number(ordered[Math.ceil(ordered.length * 0.95) - 1].toFixed(3))
}
