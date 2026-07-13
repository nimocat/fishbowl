export interface FingerprintNormalizationOptions {
  projectRoots?: readonly string[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeFingerprint(
  input: string,
  options: FingerprintNormalizationOptions = {},
): string {
  let normalized = input.replace(/\\/g, '/').replace(/\r\n?/g, '\n')
  const roots = [...(options.projectRoots ?? [])]
    .map((root) => root.replace(/\\/g, '/').replace(/\/$/, ''))
    .sort((left, right) => right.length - left.length)

  for (const root of roots) {
    normalized = normalized.replace(new RegExp(escapeRegExp(root), 'gi'), '<project>')
  }

  normalized = normalized
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '<uuid>',
    )
    .replace(/:(\d+):(\d+)(?=\b)/g, ':<line>:<column>')
    .replace(/\((\d+),(\d+)\)/g, '(<line>,<column>)')
    .replace(/\bline\s+\d+\b/gi, (match) => match.replace(/\d+/, '<line>'))

  return normalized
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}
