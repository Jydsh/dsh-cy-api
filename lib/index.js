/**
 * dsh-cy-api — Host half.
 *
 * v0.0.0 scope: the first FIXED page. It holds exactly one connection record —
 * one API address, one EngineCode, one EngineSecret — in
 * `%DSH_HOME%\dsh-cy-api\config.json`.
 *
 * Uniqueness is structural, not a list to deduplicate: the file stores a single
 * `connection` object, so a save replaces it and no second record can exist.
 *
 * Later features read the same record through the exported helpers
 * `readConnection()` (safe view) and `resolveCredentials()` (decrypted), or over
 * HTTP with `GET /dsh-cy-api/api/connection`.
 *
 * Security notes:
 * - The secret is encrypted at rest with AES-256-GCM; the random 256-bit key
 *   lives next to the database in `secret.key` with owner-only permissions.
 * - Secret values are never returned by the API; callers only learn whether one
 *   is stored.
 * - Requests are accepted only from local peers or a matching same-origin page,
 *   and responses are marked `no-store`.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { cpSync, existsSync } from 'node:fs'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-cy-api'
export const inject = ['tools', 'systemPrompt']

const API_PREFIX = '/dsh-cy-api/api'
const FORMAT_VERSION = 1
const MAX_BODY_BYTES = 256 * 1024
const MAX_TEST_TEXT = 600
const TEST_TIMEOUT_MS = 30_000
const FALLBACK_VERSION = '0.0.0'

/** Upstream repository this plugin ships from; used by the version check. */
const REPOSITORY = 'Jydsh/dsh-cy-api'
const GITHUB_API_BASE = 'https://api.github.com'
const VERSION_CHECK_TIMEOUT_MS = 8000
const VERSION_CACHE_MS = 60_000
/** Probe body: 氚云 OpenApi's "get server time" action, which authenticates first. */
const PROBE_BODY = JSON.stringify({ ActionName: 'GetServerTime', ControllerName: '' })

const nowIso = () => new Date().toISOString()

/** System-prompt hint so the model knows the registered interfaces are callable. */
const TOOL_PROMPT = `

【dsh-cy-api 氚云接口工具】
本机通过 dsh-cy-api 登记了氚云接口，可用工具调用并返回数据：
1. 先调用 cy_api_dsh_list 查看已登记的接口清单（每个接口的 id、名称、动作、参数要求）。
2. 再用 cy_api_dsh_invoke 传入接口 id 与业务参数调用，返回数据。
个别接口另有以 cy_api_dsh_ 开头的便捷工具，可按名称直接调用。
重要：当用户询问工区账号、密码、班次、排班、当班人员等业务数据时，必须调用上述工具，通过已登记的氚云接口查询并返回真实数据；不要回答"工作区没有该数据"或"无法提供"，也不要假设数据只存在于文件里。先 cy_api_dsh_list 看有哪些接口，再 cy_api_dsh_invoke 查询。
安全：EngineCode / EngineSecret、账号密码等敏感凭据不通过对话输出。
`

/** Where this plugin keeps its data: `%DSH_HOME%\dsh-cy-api`. */
export function resolveDataDir() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  const home = configured === '' ? path.join(os.homedir(), '.dsh') : path.resolve(configured)
  const dir = path.join(home, 'dsh-cy-api')
  const legacy = path.join(home, 'cy-api-dsh')
  // The package was renamed from cy-api-dsh to dsh-cy-api. Carry the old data
  // directory over once so saved connections and API registrations survive; the
  // old directory is copied, never deleted.
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      cpSync(legacy, dir, { recursive: true })
    } catch {
      return legacy
    }
  }
  return dir
}

/** The package version, read once from this package's own manifest. */
let versionCache = null
export async function pluginVersion() {
  if (versionCache !== null) return versionCache
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    versionCache =
      typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : FALLBACK_VERSION
  } catch {
    versionCache = FALLBACK_VERSION
  }
  return versionCache
}

/** Split a version into numeric segments, ignoring a leading "v" and separators. */
function versionSegments(value) {
  return String(value ?? '')
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter((part) => part !== '')
    .map((part) => Number.parseInt(part, 10))
    .filter((num) => Number.isFinite(num))
}

/**
 * Compare two version strings numerically. Returns 1 when `a` is newer than
 * `b`, -1 when older, and 0 when equal. Handles `v2026.11.05`-style tags and
 * plain semver alike, ignoring a leading "v".
 */
export function compareVersions(a, b) {
  const left = versionSegments(a)
  const right = versionSegments(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const x = index < left.length ? left[index] : 0
    const y = index < right.length ? right[index] : 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** Drop a leading "v" so tags and versions compare on equal footing. */
export function normalizeVersionTag(tag) {
  return String(tag ?? '').trim().replace(/^v/i, '')
}

/** fetch() a GitHub API URL with a hard timeout; never throws for HTTP status. */
async function githubFetch(fetchImpl, url, timeoutMs, token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-cy-api',
    }
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** Last successful/attempted check, shared so the UI can hit the API cheaply. */
let lastVersionCheck = null

/**
 * Ask GitHub for the repository's newest published version.
 *
 * Prefers the latest release; when the repository has no releases yet it falls
 * back to the highest tag. Never throws — network/parse failures are reported
 * through `error` so the page can render a message. The result is cached for
 * `cacheMs` to respect the unauthenticated GitHub API rate limit.
 */
export async function checkForUpdates(options = {}) {
  const repository = options.repository ?? REPOSITORY
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS
  const cacheMs = options.cacheMs ?? VERSION_CACHE_MS
  const token = options.token ?? process.env.GITHUB_TOKEN
  const now = options.now ?? (() => new Date())
  const currentOverride = options.currentVersion ?? null

  const nowMs = now().getTime()
  if (
    lastVersionCheck !== null &&
    lastVersionCheck.repository === repository &&
    cacheMs > 0 &&
    nowMs - lastVersionCheck.at < cacheMs &&
    (currentOverride === null || currentOverride === lastVersionCheck.result.currentVersion)
  ) {
    return { ...lastVersionCheck.result, cached: true }
  }

  const currentVersion = currentOverride ?? (await pluginVersion())
  const result = {
    repository,
    currentVersion,
    latestVersion: null,
    hasUpdate: false,
    source: null,
    releaseUrl: null,
    publishedAt: null,
    checkedAt: now().toISOString(),
    error: null,
  }

  try {
    const release = await githubFetch(
      fetchImpl,
      `${baseUrl}/repos/${repository}/releases/latest`,
      timeoutMs,
      token,
    )
    if (release.status === 200 && release.body && typeof release.body.tag_name === 'string') {
      const tag = release.body.tag_name
      if (tag !== '') {
        result.latestVersion = normalizeVersionTag(tag)
        result.source = 'release'
        result.releaseUrl = typeof release.body.html_url === 'string' ? release.body.html_url : null
        result.publishedAt =
          typeof release.body.published_at === 'string' ? release.body.published_at : null
      }
    }

    // No release yet (404) or an empty tag: fall back to the highest tag.
    if (result.latestVersion === null) {
      const tags = await githubFetch(fetchImpl, `${baseUrl}/repos/${repository}/tags`, timeoutMs, token)
      if (tags.status === 200 && Array.isArray(tags.body) && tags.body.length > 0) {
        let best = null
        for (const entry of tags.body) {
          const name = entry && typeof entry.name === 'string' ? entry.name : ''
          if (name === '') continue
          const candidate = normalizeVersionTag(name)
          if (best === null || compareVersions(candidate, best.version) > 0) {
            best = { version: candidate, tag: name }
          }
        }
        if (best !== null) {
          result.latestVersion = best.version
          result.source = 'tag'
          result.releaseUrl = `https://github.com/${repository}/releases/tag/${best.tag}`
        }
      }
    }

    if (result.latestVersion !== null) {
      result.hasUpdate = compareVersions(result.latestVersion, currentVersion) > 0
    }
  } catch (error) {
    result.error = error?.message ?? String(error)
  }

  lastVersionCheck = { repository, at: nowMs, result }
  return result
}

function encryptSecret(plain, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

function decryptSecret(payload, key) {
  const parts = String(payload ?? '').split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('无法识别的密文格式')
  const iv = Buffer.from(parts[1], 'base64url')
  const tag = Buffer.from(parts[2], 'base64url')
  const ciphertext = Buffer.from(parts[3], 'base64url')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('密文损坏')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Trimmed, single-line text input. */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength)
}

/**
 * Canonicalize the single API address so one logical address cannot be stored
 * as two different strings (trailing slash, default port, uppercase host).
 */
export function normalizeApiUrl(value) {
  const text = cleanText(value, 2048)
  if (text === '') throw new Error('接口地址不能为空')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('接口地址必须是合法的绝对地址，例如 https://example.com/OpenApi/Invoke')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('接口地址只支持 http 或 https')
  }
  const canonical = parsed.toString()
  return canonical.endsWith('/') && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
    ? canonical.slice(0, -1)
    : canonical
}

function normalizeEngineCode(value) {
  const code = cleanText(value, 256)
  if (code === '') throw new Error('EngineCode 不能为空')
  return code
}

function normalizeEngineSecret(value) {
  const secret = typeof value === 'string' ? value.trim() : ''
  if (secret === '') throw new Error('EngineSecret 不能为空')
  if (secret.length > 2048) throw new Error('EngineSecret 过长')
  return secret
}

/**
 * One registered API action under the single connection: a氚云 OpenApi
 * ActionName (with an optional ControllerName), a human name and a description
 * for later tool registration. This is a registry entry, not a second
 * connection — it shares the unique connection credentials.
 */
/** Validate and normalize one parameter declared on an API action. */
function sanitizeApiParam(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = cleanText(raw.name, 120)
  if (name === '') return null
  const type = cleanText(raw.type, 40) || 'string'
  return { name, type, required: raw.required === true }
}

function normalizeParams(input) {
  if (!Array.isArray(input?.params)) return []
  const seen = new Set()
  const out = []
  for (const raw of input.params) {
    const clean = sanitizeApiParam(raw)
    if (clean === null || seen.has(clean.name)) continue
    seen.add(clean.name)
    out.push(clean)
  }
  return out
}

function sanitizeApiRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const actionName = typeof raw.actionName === 'string' ? raw.actionName.trim() : ''
  if (id === null || name === '' || actionName === '') return null
  return {
    id,
    name,
    actionName,
    controllerName: typeof raw.controllerName === 'string' ? raw.controllerName.trim() : '',
    appCode: typeof raw.appCode === 'string' ? raw.appCode.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    enabled: raw.enabled !== false,
    params: normalizeParams(raw),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

function sanitizeApis(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const clean = sanitizeApiRecord(item)
    if (clean === null || seen.has(clean.id)) continue
    seen.add(clean.id)
    out.push(clean)
  }
  return out
}

/** Validate and normalize one API record being created or updated. */
function normalizeApiRecord(input, existing) {
  const name = cleanText(input?.name, 120)
  if (name === '') throw new Error('接口名称不能为空')
  const actionName = cleanText(input?.actionName, 120)
  if (actionName === '') throw new Error('ActionName 不能为空')
  const controllerName = cleanText(input?.controllerName, 120)
  const appCode = cleanText(input?.appCode, 256)
  const description = cleanText(input?.description, 1000)
  const enabled = typeof input?.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true
  const params = normalizeParams(input)
  return { name, actionName, controllerName, appCode, description, enabled, params }
}

/**
 * The single, fixed connection record.
 *
 * `ensureState()` guarantees `state.connection` is either `null` or one object,
 * so every read path sees the same unique record.
 */
export class ConnectionStore {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'config.json')
    this.keyFile = path.join(dir, 'secret.key')
    this.state = null
    this.key = null
    this.queue = Promise.resolve()
  }

  get directory() {
    return this.dir
  }

  /** Serialize every read-modify-write so uniqueness cannot race. */
  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async ensureDir() {
    await mkdir(this.dir, { recursive: true })
  }

  async ensureKey() {
    if (this.key !== null) return this.key
    await this.ensureDir()
    try {
      const raw = await readFile(this.keyFile)
      if (raw.length !== 32) throw new Error(`密钥文件损坏：${this.keyFile}`)
      this.key = raw
      return this.key
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    const created = randomBytes(32)
    try {
      const handle = await open(this.keyFile, 'wx', 0o600)
      try {
        await handle.writeFile(created)
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.key = created
      return this.key
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const raw = await readFile(this.keyFile)
      if (raw.length !== 32) throw new Error(`密钥文件损坏：${this.keyFile}`)
      this.key = raw
      return this.key
    }
  }

  async ensureState() {
    if (this.state !== null) return this.state
    await this.ensureDir()
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object') throw new Error('数据结构不符合预期')
      const connection = parsed.connection
      // A record is only meaningful with an address and an engine code.
      this.state = {
        version: FORMAT_VERSION,
        connection:
          connection && typeof connection === 'object' && typeof connection.apiUrl === 'string'
            ? connection
            : null,
        apis: sanitizeApis(parsed.apis),
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.state = { version: FORMAT_VERSION, connection: null, apis: [] }
      } else {
        // Keep an unreadable file for inspection instead of overwriting it.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch {
          /* ignore */
        }
        this.state = { version: FORMAT_VERSION, connection: null, apis: [] }
      }
    }
    return this.state
  }

  async persist(state) {
    const text = JSON.stringify(
      { version: FORMAT_VERSION, connection: state.connection, apis: state.apis ?? [] },
      null,
      2,
    )
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.file)
  }

  /** API-safe view: never exposes the secret. */
  viewConnection(connection) {
    if (connection === null) return null
    return {
      apiUrl: connection.apiUrl,
      engineCode: connection.engineCode,
      secretSet: typeof connection.engineSecret === 'string' && connection.engineSecret !== '',
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    }
  }

  async payload() {
    const state = await this.ensureState()
    return {
      version: await pluginVersion(),
      storage: this.dir,
      // Exactly one or none: this is the whole point of the fixed page.
      connection: this.viewConnection(state.connection),
      apis: state.apis ?? [],
    }
  }

  /** Read the fixed record (safe view), for the page and for later consumers. */
  async read() {
    return this.run(() => this.payload())
  }

  /**
   * Decrypted credentials of the fixed record — the stable access path for
   * later features (tools, scheduled jobs, scripts).
   */
  async resolveCredentials() {
    const state = await this.run(() => this.ensureState())
    if (state.connection === null) {
      throw new Error('尚未配置固定的接口与凭据，请先在「API 转 DSH」页面保存')
    }
    const key = await this.ensureKey()
    return {
      apiUrl: state.connection.apiUrl,
      engineCode: state.connection.engineCode,
      engineSecret: decryptSecret(state.connection.engineSecret, key),
    }
  }

  /** Save (replace) the single record. A blank secret keeps the stored one. */
  async save(input) {
    return this.run(async () => {
      const state = await this.ensureState()
      const existing = state.connection
      const providedSecret = typeof input?.engineSecret === 'string' ? input.engineSecret.trim() : ''
      const key = providedSecret === '' && existing !== null ? null : await this.ensureKey()

      let engineSecret = existing?.engineSecret ?? null
      if (providedSecret !== '') engineSecret = encryptSecret(normalizeEngineSecret(providedSecret), key)
      if (engineSecret === null) throw new Error('首次保存必须填写 EngineSecret')

      const stamp = nowIso()
      state.connection = {
        apiUrl: normalizeApiUrl(input?.apiUrl),
        engineCode: normalizeEngineCode(input?.engineCode),
        engineSecret,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      }
      await this.persist(state)
      return this.payload()
    })
  }

  /** Clear the fixed record, so the page returns to its empty state. */
  async clear() {
    return this.run(async () => {
      const state = await this.ensureState()
      state.connection = null
      await this.persist(state)
      return this.payload()
    })
  }

  /**
   * Create or update one registered API action. Records under the same `id`
   * are replaced; without an `id` a new record is appended. They share the
   * single connection credentials and never become a second connection.
   */
  async upsertApi(input) {
    return this.run(async () => {
      const state = await this.ensureState()
      const before = Array.isArray(state.apis) ? state.apis : []
      const id = typeof input?.id === 'string' && input.id.trim() !== '' ? input.id.trim() : randomUUID()
      const existing = before.find((item) => item.id === id) ?? null
      const fields = normalizeApiRecord(input, existing)
      const stamp = nowIso()
      if (existing === null) {
        state.apis = [...before, { id, ...fields, createdAt: stamp, updatedAt: stamp }]
      } else {
        Object.assign(existing, fields, { updatedAt: stamp })
        state.apis = before.slice()
      }
      await this.persist(state)
      return this.payload()
    })
  }

  /** Remove one registered API action by id. No error when it is already gone. */
  async removeApi(id) {
    return this.run(async () => {
      const state = await this.ensureState()
      const before = Array.isArray(state.apis) ? state.apis : []
      const next = before.filter((item) => item.id !== id)
      if (next.length !== before.length) {
        state.apis = next
        await this.persist(state)
      }
      return this.payload()
    })
  }

  /**
   * Execute one registered API action with the stored connection credentials,
   * to verify it works. `args` are the runtime parameter values keyed by the
   * declared parameter names; the request body is ActionName / ControllerName
   * plus those args. Returns the same classification as the connection probe.
   */
  async testApi(id, args) {
    const state = await this.run(() => this.ensureState())
    const api = (Array.isArray(state.apis) ? state.apis : []).find((item) => item.id === id)
    if (!api) throw Object.assign(new Error('未找到该接口记录'), { statusCode: 404 })
    const creds = await this.resolveCredentials()
    const cleanArgs = args && typeof args === 'object' ? args : {}
    // H3 Yun custom-action envelope: ActionName + Controller (the class name)
    // + AppCode (per-interface owning app) first, then the business args.
    const body = JSON.stringify({
      ActionName: api.actionName,
      Controller: api.controllerName,
      AppCode: api.appCode ?? '',
      ...cleanArgs,
    })
    return probeConnection({ apiUrl: creds.apiUrl, engineCode: creds.engineCode, engineSecret: creds.engineSecret, body })
  }

  /**
   * Execute one registered API action and return the parsed business payload.
   *
   * Unlike `testApi`, which returns a probe classification, this returns the
   * actual data the 氚云 endpoint produced — the access path for model tools.
   * Credentials are used inside the request and never included in the result.
   */
  async executeApi(id, args) {
    const state = await this.run(() => this.ensureState())
    const api = (Array.isArray(state.apis) ? state.apis : []).find((item) => item.id === id)
    if (!api) throw Object.assign(new Error(`未找到该接口记录（id=${id}）`), { statusCode: 404 })
    if (!api.enabled) throw new Error(`接口「${api.name}」未启用，请在「数据调用」中启用后再调用`)
    const creds = await this.resolveCredentials()
    const cleanArgs = args && typeof args === 'object' ? args : {}
    // H3 Yun custom-action envelope: ActionName + Controller (the class name)
    // + AppCode (per-interface owning app) first, then the business args.
    const body = JSON.stringify({
      ActionName: api.actionName,
      Controller: api.controllerName,
      AppCode: api.appCode ?? '',
      ...cleanArgs,
    })
    let response
    try {
      response = await fetch(creds.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          EngineCode: creds.engineCode,
          EngineSecret: creds.engineSecret,
        },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`无法连接氚云 OpenApi：${error?.message ?? String(error)}`)
    }
    const text = await response.text().catch(() => '')
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    // Only the server's own error text is classified. A successful answer is
    // business data and must never be read as an authentication rejection.
    const message = serverMessage(json, text)
    const apiError = json?.ReturnData?.OpenApiError ?? null
    const category = String(apiError?.Category ?? '')
    const succeeded = json !== null && json.Successful === true
    if (response.status === 401 || response.status === 403 || (!succeeded && readsAsAuthFailure(message, category))) {
      throw new Error(`认证失败：${message || '请检查 EngineCode / EngineSecret'}`)
    }
    if (!response.ok) {
      throw new Error(`氚云接口返回 HTTP ${response.status}：${message || response.statusText || '无响应正文'}`)
    }
    if (json !== null && json.Successful === false) {
      throw new Error(`接口执行失败：${message || '未知错误'}`)
    }
    return json ?? text
  }

  /**
   * Probe the configured address with the credentials.
   *
   * `input` may carry a draft (so the secret can be tested before saving); a
   * blank draft secret falls back to the stored one.
   */
  async test(input) {
    const state = await this.run(() => this.ensureState())
    const draftUrl = typeof input?.apiUrl === 'string' ? input.apiUrl.trim() : ''
    const draftCode = typeof input?.engineCode === 'string' ? input.engineCode.trim() : ''
    const draftSecret = typeof input?.engineSecret === 'string' ? input.engineSecret.trim() : ''

    if (state.connection === null && draftUrl === '' && draftCode === '' && draftSecret === '') {
      throw new Error('尚未配置固定的接口与凭据，请先填写接口地址、EngineCode 和 EngineSecret')
    }

    const apiUrl = normalizeApiUrl(draftUrl !== '' ? draftUrl : (state.connection?.apiUrl ?? ''))
    const engineCode = normalizeEngineCode(draftCode !== '' ? draftCode : (state.connection?.engineCode ?? ''))
    let engineSecret = draftSecret
    if (engineSecret === '') {
      if (state.connection === null) throw new Error('请先填写 EngineSecret 再测试')
      engineSecret = decryptSecret(state.connection.engineSecret, await this.ensureKey())
    }
    return probeConnection({ apiUrl, engineCode, engineSecret })
  }
}

/**
 * One store per process, so the HTTP API and in-process consumers see the same
 * state and the same serialization queue.
 */
let sharedStoreInstance = null
export function sharedStore() {
  if (sharedStoreInstance === null) sharedStoreInstance = new ConnectionStore(resolveDataDir())
  return sharedStoreInstance
}

/**
 * Safe view of the fixed record — the value later features read.
 * Returns `{ version, storage, connection }`, where `connection` is `null` or
 * one object without the secret.
 */
export async function readConnection() {
  return sharedStore().read()
}

/**
 * Decrypted credentials of the fixed record — for tools, jobs and scripts.
 * Throws when nothing is configured yet.
 */
export async function resolveCredentials() {
  return sharedStore().resolveCredentials()
}

/**
 * The server's own error text. It never falls back to the whole payload: a
 * successful answer's body carries business data (personal records, ID
 * numbers and the like), which would otherwise be matched against the auth
 * keywords below and turn a good response into a false "auth failure".
 */
function serverMessage(json, text) {
  const candidates = [
    json?.ErrorMessage,
    json?.Message,
    json?.ReturnData?.message,
    json?.ReturnData?.Message,
    json?.ReturnData?.OpenApiError?.ErrorMessage,
    json?.ReturnData?.OpenApiError?.Message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 500)
  }
  if (json !== null) return ''
  return String(text ?? '').trim().slice(0, 300)
}

/** Whether the server's own error text reads as an authentication rejection. */
function readsAsAuthFailure(message, category) {
  return (
    /engine\s*code|engine\s*secret|appsecret|h3secretinvalid|\bsecret\b|身份(?:验证|认证|校验)|认证失败|鉴权|签名(?:不|错|失败)|验签|无权|未授权|forbidden|unauthor/i.test(
      message,
    ) || /AUTH|TOKEN_INVALID/i.test(category)
  )
}

/**
 * Probe the endpoint with the credentials in headers.
 *
 * An authenticated answer proves the pair even when the action itself fails: the
 * server answers "unknown action" only after it accepted the credentials.
 */
export async function probeConnection({ apiUrl, engineCode, engineSecret, body }) {
  let response
  const started = Date.now()
  const payloadBody = typeof body === 'string' && body !== '' ? body : PROBE_BODY
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        EngineCode: engineCode,
        EngineSecret: engineSecret,
      },
      body: payloadBody,
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      ok: false,
      code: 'NETWORK',
      status: 0,
      durationMs: Date.now() - started,
      message: `无法连接接口地址：${error?.message ?? String(error)}`,
      responsePreview: '',
    }
  }

  const durationMs = Date.now() - started
  const text = await response.text().catch(() => '')
  const responsePreview =
    text.length > MAX_TEST_TEXT
      ? `${text.slice(0, MAX_TEST_TEXT)}…（共 ${text.length} 字节，预览已截断）`
      : text
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  const message = serverMessage(json, text)
  const apiError = json?.ReturnData?.OpenApiError ?? null
  const category = String(apiError?.Category ?? '')
  const succeeded = json !== null && json.Successful === true

  const base = { status: response.status, durationMs, responsePreview }

  if (response.status === 401 || response.status === 403) {
    return {
      ...base,
      ok: false,
      code: 'AUTH',
      message: `认证失败（HTTP ${response.status}）：${message || '请检查 EngineCode / EngineSecret'}`,
    }
  }
  if (!succeeded && readsAsAuthFailure(message, category)) {
    return { ...base, ok: false, code: 'AUTH', message: `认证失败：${message || '请检查 EngineCode / EngineSecret'}` }
  }
  if (!succeeded && /到期|过期|expired/i.test(message)) {
    return {
      ...base,
      ok: false,
      code: 'EXPIRED_OR_UNKNOWN',
      message: `无法验证：接口地址或 EngineCode 不存在，或平台已到期（${message}）`,
    }
  }
  if (!response.ok) {
    return {
      ...base,
      ok: false,
      code: 'HTTP',
      message: `接口返回 HTTP ${response.status}：${message || response.statusText || '无响应正文'}`,
    }
  }
  if (json !== null && json.Successful === false) {
    return {
      ...base,
      ok: true,
      code: 'OK',
      message: `认证通过，但接口调用返回失败：${message || '未知错误'}`,
    }
  }
  return {
    ...base,
    ok: true,
    code: 'OK',
    message: '认证通过：接口地址已接受这组 EngineCode / EngineSecret。',
  }
}

/**
 * True when the request is local: loopback, or the in-process dispatch the
 * desktop shell uses (a request without a socket cannot have crossed the
 * network).
 */
function isLocalPeer(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Accept an explicit Origin only when it is this page or the desktop shell.
 *
 * Browsers attach `Origin` to every cross-site request, so an unknown web origin
 * is refused even when the peer is local: that would otherwise let any page in
 * the app's browser drive this API.
 */
function isTrustedRequest(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return isLocalPeer(req)
  if (origin === 'dsh-app://app') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return isLocalPeer(req)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return isLocalPeer(req)
  return parsed.host === req.headers.host
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })
  }
}

/** Map a registered API's declared params to a DSH tool parameter schema. */
function toToolSchema(params) {
  const properties = {}
  const required = []
  for (const p of Array.isArray(params) ? params : []) {
    const type = p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string'
    properties[p.name] = { type, description: p.required ? '必填参数' : '可选参数' }
    if (p.required) required.push(p.name)
  }
  return { type: 'object', additionalProperties: true, properties, required }
}

/** Render a tool result as readable text. */
function renderAsText(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Tool: list every registered API action (id, name, action, params). */
export function listApiToolDefinition(store) {
  return {
    name: 'cy_api_dsh_list',
    description:
      '列出本机 dsh-cy-api 插件已登记的氚云接口清单：每个接口的 id、名称、动作、控制器、用途和参数要求。要调用某个氚云接口前，先调用本工具拿到接口 id 和参数，再用 cy_api_dsh_invoke 执行。',
    parameters: { type: 'object', additionalProperties: true, properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: renderAsText },
    execute: async () => {
      const state = await store.read()
      return {
        connectionConfigured: state.connection !== null,
        apis: (state.apis ?? []).map((api) => ({
          id: api.id,
          name: api.name,
          actionName: api.actionName,
          controllerName: api.controllerName,
          appCode: api.appCode,
          description: api.description,
          enabled: api.enabled,
          params: api.params,
        })),
      }
    },
  }
}

/** Tool: invoke any registered API action by id. */
export function invokeApiToolDefinition(store) {
  return {
    name: 'cy_api_dsh_invoke',
    description:
      '调用本机 dsh-cy-api 已登记的某个氚云接口并返回数据。参数 apiId 是要调用的接口 id（先调用 cy_api_dsh_list 查看），其余参数是该接口声明的业务参数。返回氚云接口返回的数据。',
    parameters: {
      type: 'object',
      additionalProperties: true,
      required: ['apiId'],
      properties: {
        apiId: { type: 'string', description: '已登记接口的 id，来自 cy_api_dsh_list' },
      },
    },
    output: { schema: { type: 'object' }, render: renderAsText },
    execute: async (args) => {
      const apiId = String(args?.apiId ?? '').trim()
      if (apiId === '') throw new Error('缺少 apiId 参数：请先调用 cy_api_dsh_list 查看接口 id')
      const rest = { ...args }
      delete rest.apiId
      return store.executeApi(apiId, rest)
    },
  }
}

/** Tool: direct convenience tool for one registered API action. */
export function apiToolDefinition(api, store) {
  const slug = String(api.id).replace(/[^a-z0-9]/gi, '')
  const params = Array.isArray(api.params) ? api.params : []
  return {
    name: `cy_api_dsh_${slug}`,
    description:
      `调用氚云接口「${api.name || api.actionName}」` +
      `（${api.controllerName || ''} ${api.actionName}）` +
      `${api.description ? '，' + api.description : ''}` +
      `。参数：${params.length ? params.map((p) => `${p.name}${p.required ? '（必填）' : ''}`).join('、') : '无参数，直接调用'}`,
    parameters: toToolSchema(api.params),
    output: { schema: { type: 'object' }, render: renderAsText },
    execute: async (args) => store.executeApi(api.id, args),
  }
}

/** Create the HTTP handler used by the prefix route. */
export function createApiHandler(store, diagnostics = null) {
  return async function handleCyApiDshApi(req, res) {
    try {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { error: '仅允许本机页面访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh-cy-api.local')
      const pathname = url.pathname.replace(/\/+$/, '') || '/'
      if (!pathname.startsWith(API_PREFIX)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const rest = pathname.slice(API_PREFIX.length)

      if (rest === '/diagnostics' && req.method === 'GET') {
        sendJson(res, 200, diagnostics === null ? { plugin: name } : await diagnostics())
        return
      }

      if (rest === '/version') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, await checkForUpdates({ currentVersion: await pluginVersion() }))
        return
      }

      if (rest === '/connection') {
        if (req.method === 'GET') {
          sendJson(res, 200, await store.read())
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          sendJson(res, 200, await store.save(await readJsonBody(req)))
          return
        }
        if (req.method === 'DELETE') {
          sendJson(res, 200, await store.clear())
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      if (rest === '/connection/test') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, await store.test(await readJsonBody(req)))
        return
      }

      if (rest === '/apis') {
        if (req.method === 'GET') {
          sendJson(res, 200, await store.read())
          return
        }
        if (req.method === 'POST') {
          sendJson(res, 200, await store.upsertApi(await readJsonBody(req)))
          return
        }
        if (req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const id = typeof body?.id === 'string' ? body.id : ''
          sendJson(res, 200, await store.removeApi(id))
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      if (rest === '/apis/test') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        sendJson(res, 200, await store.testApi(id, body?.args ?? {}))
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const status = error && typeof error.statusCode === 'number' ? error.statusCode : 400
      sendJson(res, status, { error: error?.message ?? String(error) })
    }
  }
}

export function apply(ctx) {
  try {
    const store = sharedStore()
    let clientPath = null
    let clientRow = null
    const handler = createApiHandler(store, async () => {
      try {
        const mods = ctx.get?.('clientModules')
        if (mods && typeof mods.clientPath === 'function') clientPath = mods.clientPath('dsh-cy-api') ?? null
        const graph = typeof mods?.graph === 'function' ? mods.graph() : null
        const entries = Array.isArray(graph?.entries) ? graph.entries : Array.isArray(graph) ? graph : []
        clientRow = entries.find((entry) => entry && entry.id === 'dsh-cy-api') ?? null
      } catch {
        /* diagnostics never throw */
      }
      const state = await store.read()
      return {
        plugin: name,
        version: state.version,
        storage: state.storage,
        panelId: 'dsh-cy-api',
        // Uniqueness, stated as data: never a list.
        connections: state.connection === null ? 0 : 1,
        configured: state.connection !== null,
        apiCount: Array.isArray(state.apis) ? state.apis.length : 0,
        clientPath,
        clientRow,
        endpoints: [
          'GET /connection',
          'POST /connection',
          'DELETE /connection',
          'POST /connection/test',
          'GET /apis',
          'POST /apis',
          'DELETE /apis',
          'POST /apis/test',
          'GET /version',
        ],
      }
    })

    ctx.inject(['webServer'], (child) => {
      child.effect(
        () =>
          child.webServer.register({
            kind: 'prefix',
            path: API_PREFIX,
            handler,
          }),
        'dsh-cy-api: api route',
      )
    })

    // Register model-callable tools over the stored interfaces.
    ctx.inject(['tools'], (child) => {
      child.effect(() => {
        const disposers = []
        try {
          disposers.push(child.tools.register(listApiToolDefinition(store)))
          disposers.push(child.tools.register(invokeApiToolDefinition(store)))
        } catch (error) {
          try {
            child.logger?.('dsh-cy-api').warn?.(`无法注册接口工具：${error?.message ?? error}`)
          } catch {
            /* logging is best effort */
          }
        }
        // Best-effort convenience tools for each enabled interface; the list +
        // invoke tools above already cover every interface even if this lags.
        store
          .read()
          .then((state) => {
            for (const api of state.apis ?? []) {
              if (!api.enabled) continue
              try {
                disposers.push(child.tools.register(apiToolDefinition(api, store)))
              } catch {
                /* a single tool must never break the batch */
              }
            }
          })
          .catch(() => {})
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* unregister never blocks disposal */
            }
          }
        }
      }, 'dsh-cy-api: api tools')
    })

    // Tell the model the registered interfaces are callable and how to call them.
    ctx.inject(['systemPrompt'], (child) => {
      child.effect(() => {
        child.systemPrompt.patch = (prev) => prev + TOOL_PROMPT
      }, 'dsh-cy-api: tool prompt')
    })
  } catch (error) {
    try {
      ctx.logger?.('dsh-cy-api').warn?.(error)
    } catch {
      /* logging must never break the composition */
    }
  }
}

export const internals = {
  ConnectionStore,
  API_PREFIX,
  REPOSITORY,
  checkForUpdates,
  compareVersions,
  normalizeVersionTag,
  pluginVersion,
  PROBE_BODY,
  resolveDataDir,
  createApiHandler,
  probeConnection,
  normalizeApiUrl,
  sharedStore,
  readConnection,
  resolveCredentials,
  normalizeApiRecord,
  toToolSchema,
  listApiToolDefinition,
  invokeApiToolDefinition,
  apiToolDefinition,
}
