const REDACTED = '[REDACTED]'
const TRUNCATED = '[TRUNCATED]'
const SENSITIVE_FLAG = /^--(?:token|password|passwd|secret|api[_-]?key)$/i

export function redactSecrets(input: string): string {
  return input
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\/\/[^\s/:@]+:[^\s/@]+@/g, `//${REDACTED}@`)
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(
      /("(?:token|password|passwd|secret|api[_-]?key)"\s*:\s*)"[^"]*"/gi,
      `$1"${REDACTED}"`,
    )
    .replace(
      /(--(?:token|password|passwd|secret|api[_-]?key)(?:=|\s+))[^\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(token|password|passwd|secret|api[_-]?key)\s*([=:])\s*[^\s]+/gi, `$1$2${REDACTED}`)
}

export function redactArgv(argv: readonly string[]): string[] {
  let redactNext = false
  return argv.map((argument) => {
    if (redactNext) {
      redactNext = false
      return REDACTED
    }
    if (SENSITIVE_FLAG.test(argument)) {
      redactNext = true
      return argument
    }
    return redactSecrets(argument)
  })
}

function takeUtf8Bytes(input: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of input) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) {
      break
    }
    result += character
    bytes += characterBytes
  }
  return result
}

export function boundedRedactedExcerpt(input: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative integer')
  }
  const redacted = redactSecrets(input)
  if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) {
    return redacted
  }
  const marker = takeUtf8Bytes(TRUNCATED, maxBytes)
  if (marker.length < TRUNCATED.length) {
    return marker
  }
  return takeUtf8Bytes(redacted, maxBytes - Buffer.byteLength(marker, 'utf8')) + marker
}
