/**
 * Vendored anonymous HTTP(S) WebFetchProvider for the dsh web seam.
 *
 * Adapted from @deepseek-ai/dsh-web-fetch-http (MIT, deepseek-ai/deepseek-harness)
 * into a self-contained ESM plugin with zero runtime dependencies: the official
 * package is not published to npm, so this local copy supplies the same
 * provider contract (`ctx.web.registerFetchProvider`) that
 * `@deepseek-ai/dsh-tool-web`'s `web_fetch` tool resolves at call time.
 *
 * Transport hygiene: http(s) only, no credentials in URLs, same-origin redirects
 * only, byte/char caps, explicit product User-Agent, and SSRF caveat — do not
 * run this where the agent could reach sensitive internal targets.
 */

const PLUGIN_NAME = 'web-fetch-http-local'
const PROVIDER_ID = 'http'
const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Structured errors carry a `code` that the tool layer surfaces as WebError codes. */
class ProviderError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${PLUGIN_NAME}: ${name} must be a positive finite number`)
  }
}
function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${PLUGIN_NAME}: ${name} must be a non-negative integer`)
  }
}

/** Validate a fetch URL: http(s) only, no embedded credentials, length cap. */
function validateFetchUrl(raw, maxUrlLength) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxUrlLength) {
    throw new ProviderError(`invalid URL (length must be <= ${maxUrlLength})`, 'WEB_INVALID_URL')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ProviderError('invalid URL', 'WEB_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('only http and https URLs are supported', 'WEB_BLOCKED_URL')
  }
  if (url.username || url.password) {
    throw new ProviderError('URLs with embedded credentials are not supported', 'WEB_BLOCKED_URL')
  }
  return url
}

function isSameOrigin(a, b) {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

const SUPPORTED_CONTENT_TYPES = [
  ['text/', 'text'],
  ['application/json', 'text'],
  ['application/xml', 'text'],
  ['application/xhtml+xml', 'text'],
  ['application/javascript', 'text'],
  ['text/markdown', 'text'],
]
function classifyContentType(contentType) {
  if (!contentType) return undefined
  const lower = contentType.toLowerCase()
  for (const [prefix, kind] of SUPPORTED_CONTENT_TYPES) {
    if (lower.startsWith(prefix)) return kind
  }
  return undefined
}

function charsetFrom(contentType) {
  const match = /charset=([^;\s]+)/i.exec(contentType || '')
  return match ? match[1].toLowerCase() : undefined
}

function decoderForCharset(charset) {
  try {
    return new TextDecoder(charset || 'utf-8')
  } catch {
    throw new ProviderError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
  }
}

function timeoutOf(signal, code) {
  if (!signal) return undefined
  const reason = signal.reason
  if (reason && typeof reason === 'object' && reason.code === code) return reason
  return undefined
}

function translateAbortOrNetwork(error, signal, timeoutCode) {
  if (timeoutOf(signal, timeoutCode)) {
    return new ProviderError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  }
  if (signal?.aborted) {
    return new ProviderError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  return new ProviderError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

function resolveRedirect(location, base) {
  try {
    return new URL(location, base)
  } catch {
    throw new ProviderError('invalid redirect Location', 'WEB_PROVIDER_ERROR')
  }
}

class HttpFetchProvider {
  constructor(limits) {
    this.id = PROVIDER_ID
    this.limits = limits
  }

  available() {
    return true
  }

  async fetch(request, signal) {
    if (signal?.aborted) throw new ProviderError('web fetch aborted', 'WEB_ABORTED')
    const timeoutMs = this.limits.timeoutMs
    return await this.followAndRead(request.url, signal, timeoutMs)
  }

  async followAndRead(initialUrl, signal, timeoutMs) {
    let currentUrl = validateFetchUrl(initialUrl, this.limits.maxUrlLength)
    let redirectsFollowed = 0

    const controller = new AbortController()
    const onOuterAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(() => {
      controller.abort({ code: 'WEB_FETCH_TIMEOUT' })
    }, timeoutMs)

    try {
      for (;;) {
        let response
        try {
          response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: {
              'user-agent': this.limits.userAgent,
              accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
            },
            signal: controller.signal,
          })
        } catch (error) {
          throw translateAbortOrNetwork(error, controller.signal, 'WEB_FETCH_TIMEOUT')
        }

        if (isRedirectStatus(response.status)) {
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel()
            throw new ProviderError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.headers.get('location')
          if (location === null) {
            await response.body?.cancel()
            throw new ProviderError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          const target = resolveRedirect(location, currentUrl)
          let validatedTarget
          try {
            validatedTarget = validateFetchUrl(target.toString(), this.limits.maxUrlLength)
            if (!isSameOrigin(validatedTarget, currentUrl)) {
              throw new ProviderError(
                `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
                'WEB_REDIRECT_BLOCKED',
              )
            }
          } catch (error) {
            await response.body?.cancel()
            throw error
          }
          await response.body?.cancel()
          currentUrl = validatedTarget
          redirectsFollowed++
          continue
        }

        return await this.readBody(response, currentUrl, controller.signal)
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  async readBody(response, finalUrl, signal) {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new ProviderError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    let decoder
    try {
      decoder = decoderForCharset(charsetFrom(contentType))
    } catch (error) {
      await response.body?.cancel()
      throw error
    }

    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  async readCapped(response, signal) {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new ProviderError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error) {
      throw translateAbortOrNetwork(error, signal, 'WEB_FETCH_TIMEOUT')
    } finally {
      await reader.cancel().catch(() => {})
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** Cordis plugin: register the fetch provider into the web seam. */
const name = 'web-fetch-http-local'
const inject = ['web']

function apply(ctx, config) {
  const resolved = {
    maxUrlLength: config?.maxUrlLength ?? 2048,
    maxResponseBytes: config?.maxResponseBytes ?? 5_000_000,
    maxBodyChars: config?.maxBodyChars ?? 100_000,
    timeoutMs: config?.timeoutMs ?? 30_000,
    maxRedirects: config?.maxRedirects ?? 5,
    userAgent: config?.userAgent ?? DEFAULT_USER_AGENT,
  }
  assertPositiveFinite('maxUrlLength', resolved.maxUrlLength)
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)

  const provider = new HttpFetchProvider(resolved)
  ctx.web.registerFetchProvider(provider)
}

export { HttpFetchProvider, PLUGIN_NAME, apply, inject, name }
