import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ConnectionStore,
  createApiHandler,
  checkForUpdates,
  compareVersions,
  normalizeVersionTag,
} from '../lib/index.js'

const REPOSITORY = 'Jydsh/dsh-cy-api'

/** Start an HTTP server and return { base, close }. */
function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** Start the plugin's own JSON API on an ephemeral port. */
async function startPluginApi(dir) {
  const store = new ConnectionStore(dir)
  const handler = createApiHandler(store)
  const origin = await listen((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  return { store, ...origin }
}

async function api(origin, method, requestPath, body) {
  const init = { method, headers: {}, cache: 'no-store' }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(origin.base + '/dsh-cy-api/api' + requestPath, init)
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

/** Minimal fetch response stand-in: only status + json() are read. */
function jsonResponse(status, body) {
  return { status, json: async () => body }
}

test('versions compare numerically and ignore a leading v', () => {
  assert.equal(compareVersions('v2026.11.05', '2026.11.5'), 0)
  assert.equal(compareVersions('2026.11.05', '2026.10.30'), 1)
  assert.equal(compareVersions('0.0.0', '2026.11.5'), -1)
  assert.equal(compareVersions('v1.10.0', 'v1.9.0'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(normalizeVersionTag('v2026.11.05'), '2026.11.05')
  assert.equal(normalizeVersionTag(''), '')
})

test('a release supplies the newest version', async () => {
  const fetchStub = async (url) => {
    if (url.endsWith('/releases/latest')) {
      return jsonResponse(200, {
        tag_name: 'v2026.11.5',
        html_url: 'https://github.com/owner/repo/releases/tag/v2026.11.5',
        published_at: '2026-10-27T00:00:00Z',
      })
    }
    return jsonResponse(404, { message: 'Not Found' })
  }

  const result = await checkForUpdates({
    repository: 'test/release',
    currentVersion: '0.0.0',
    fetchImpl: fetchStub,
    cacheMs: 0,
  })

  assert.equal(result.error, null)
  assert.equal(result.latestVersion, '2026.11.5')
  assert.equal(result.source, 'release')
  assert.equal(result.hasUpdate, true)
  assert.equal(result.releaseUrl, 'https://github.com/owner/repo/releases/tag/v2026.11.5')
})

test('without a release the highest tag wins', async () => {
  const fetchStub = async (url) => {
    if (url.endsWith('/releases/latest')) return jsonResponse(404, { message: 'Not Found' })
    if (url.endsWith('/tags')) {
      return jsonResponse(200, [{ name: 'v1.9.0' }, { name: 'v1.10.0' }, { name: 'v2.0.0' }])
    }
    return jsonResponse(404, {})
  }

  const result = await checkForUpdates({
    repository: 'test/tags',
    currentVersion: '1.9.9',
    fetchImpl: fetchStub,
    cacheMs: 0,
  })

  assert.equal(result.error, null)
  assert.equal(result.latestVersion, '2.0.0')
  assert.equal(result.source, 'tag')
  assert.equal(result.hasUpdate, true)
  assert.equal(result.releaseUrl, 'https://github.com/test/tags/releases/tag/v2.0.0')
})

test('an empty repository reports no published version', async () => {
  const fetchStub = async (url) =>
    url.endsWith('/releases/latest') ? jsonResponse(404, {}) : jsonResponse(200, [])

  const result = await checkForUpdates({
    repository: 'test/empty',
    currentVersion: '0.0.0',
    fetchImpl: fetchStub,
    cacheMs: 0,
  })

  assert.equal(result.error, null)
  assert.equal(result.latestVersion, null)
  assert.equal(result.hasUpdate, false)
  assert.equal(result.source, null)
})

test('a network failure is reported instead of thrown', async () => {
  const fetchStub = async () => {
    throw new Error('network down')
  }

  const result = await checkForUpdates({
    repository: 'test/error',
    currentVersion: '1.0.0',
    fetchImpl: fetchStub,
    cacheMs: 0,
  })

  assert.equal(result.error, 'network down')
  assert.equal(result.latestVersion, null)
  assert.equal(result.hasUpdate, false)
})

test('GET /version returns the check result over the plugin API', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-version-'))
  const origin = await startPluginApi(dir)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.github.com')) {
      return jsonResponse(200, {
        tag_name: 'v2026.11.13',
        html_url: 'https://github.com/Jydsh/dsh-cy-api/releases/tag/v2026.11.13',
        published_at: '2026-10-27T00:00:00Z',
      })
    }
    return realFetch(url, init)
  }
  try {
    const response = await api(origin, 'GET', '/version')
    assert.equal(response.status, 200)
    assert.equal(response.body.repository, REPOSITORY)
    assert.equal(typeof response.body.currentVersion, 'string')
    assert.equal(response.body.latestVersion, '2026.11.13')
    assert.equal(response.body.hasUpdate, true)
    assert.equal(response.body.source, 'release')
    assert.equal(typeof response.body.checkedAt, 'string')

    const post = await api(origin, 'POST', '/version', {})
    assert.equal(post.status, 405)
  } finally {
    globalThis.fetch = realFetch
    await origin.close()
    await rm(dir, { recursive: true, force: true })
  }
})
