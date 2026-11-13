import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ConnectionStore,
  createApiHandler,
  normalizeApiUrl,
  probeConnection,
} from '../lib/index.js'

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

test('the address is canonicalized, so one address has one spelling', () => {
  assert.equal(normalizeApiUrl('https://Example.COM/OpenApi'), 'https://example.com/OpenApi')
  assert.equal(normalizeApiUrl('https://example.com'), 'https://example.com')
  assert.equal(normalizeApiUrl('https://example.com/'), 'https://example.com')
  assert.equal(normalizeApiUrl('  https://example.com/a  '), 'https://example.com/a')
  assert.throws(() => normalizeApiUrl(''), /不能为空/)
  assert.throws(() => normalizeApiUrl('ftp://example.com'), /http/)
  assert.throws(() => normalizeApiUrl('not a url'), /合法/)
})

test('the record is unique: saving replaces it, never appends', async () => {
  const pluginVersion = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).version
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    const empty = await api(origin, 'GET', '/connection')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.connection, null)
    assert.equal(empty.body.version, pluginVersion)

    const created = await api(origin, 'POST', '/connection', {
      apiUrl: 'https://www.h3yun.com/OpenApi/Invoke',
      engineCode: 'ENGINE-1',
      engineSecret: 'super-secret-value',
    })
    assert.equal(created.status, 200)
    const first = created.body.connection
    assert.equal(first.apiUrl, 'https://www.h3yun.com/OpenApi/Invoke')
    assert.equal(first.engineCode, 'ENGINE-1')
    assert.equal(first.secretSet, true)
    assert.equal(first.engineSecret, undefined, 'the secret must never be returned')

    // A second save is an edit of the same record.
    const replaced = await api(origin, 'POST', '/connection', {
      apiUrl: 'https://example.com/invoke',
      engineCode: 'ENGINE-2',
      engineSecret: '',
    })
    assert.equal(replaced.body.connection.apiUrl, 'https://example.com/invoke')
    assert.equal(replaced.body.connection.engineCode, 'ENGINE-2')
    assert.equal(replaced.body.connection.createdAt, first.createdAt)
    assert.notEqual(replaced.body.connection.updatedAt, undefined)
    assert.equal(replaced.body.connection.secretSet, true, 'a blank secret keeps the stored one')

    // The file itself holds one object, not a list.
    const raw = await readFile(path.join(dir, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.deepEqual(Object.keys(parsed).sort(), ['apis', 'connection', 'version'])
    assert.equal(Array.isArray(parsed.connection), false)
    assert.equal(typeof parsed.connection, 'object')
    assert.equal(parsed.connection.apiUrl, 'https://example.com/invoke')

    // The secret is encrypted at rest and never stored in plaintext.
    assert.ok(!raw.includes('super-secret-value'))
    assert.match(parsed.connection.engineSecret, /^v1\./)

    const credentials = await new ConnectionStore(dir).resolveCredentials()
    assert.equal(credentials.apiUrl, 'https://example.com/invoke')
    assert.equal(credentials.engineCode, 'ENGINE-2')
    assert.equal(credentials.engineSecret, 'super-secret-value')

    const cleared = await api(origin, 'DELETE', '/connection')
    assert.equal(cleared.body.connection, null)
    const after = await api(origin, 'GET', '/connection')
    assert.equal(after.body.connection, null)
  } finally {
    await origin.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid input is rejected with a readable error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    const noUrl = await api(origin, 'POST', '/connection', { engineCode: 'x', engineSecret: 'y' })
    assert.equal(noUrl.status, 400)
    assert.match(noUrl.body.error, /接口地址/)

    const noCode = await api(origin, 'POST', '/connection', {
      apiUrl: 'https://example.com',
      engineSecret: 'y',
    })
    assert.equal(noCode.status, 400)
    assert.match(noCode.body.error, /EngineCode/)

    const noSecret = await api(origin, 'POST', '/connection', {
      apiUrl: 'https://example.com',
      engineCode: 'x',
    })
    assert.equal(noSecret.status, 400)
    assert.match(noSecret.body.error, /EngineSecret/)

    const badProtocol = await api(origin, 'POST', '/connection', {
      apiUrl: 'ftp://example.com',
      engineCode: 'x',
      engineSecret: 'y',
    })
    assert.equal(badProtocol.status, 400)

    const notConfigured = await api(origin, 'POST', '/connection/test', {})
    assert.equal(notConfigured.status, 400)
    assert.match(notConfigured.body.error, /尚未配置/)
  } finally {
    await origin.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the probe sends the credentials and classifies the answer', async () => {
  const seen = []
  let mode = 'ok'
  const target = await listen((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method,
        engineCode: req.headers.enginecode,
        engineSecret: req.headers.enginesecret,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Successful: true, ReturnData: {} }))
        return
      }
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ErrorMessage: 'EngineSecret 无效' }))
        return
      }
      if (mode === 'data') {
        // A successful payload whose business fields carry personal records:
        // the auth keywords must not match on the data itself.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            Successful: true,
            ErrorMessage: null,
            ReturnData: { data: [{ 姓名: '张三', 身份证号: '525011199080008166', 手机号: '13800138000' }] },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ErrorMessage: '身份认证失败' }))
    })
  })
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    const created = await api(origin, 'POST', '/connection', {
      apiUrl: target.base + '/OpenApi/Invoke',
      engineCode: 'ENGINE-1',
      engineSecret: 'secret-1',
    })
    assert.equal(created.status, 200)

    const ok = await api(origin, 'POST', '/connection/test', {})
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.code, 'OK')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].engineCode, 'ENGINE-1')
    assert.equal(seen[0].engineSecret, 'secret-1')
    assert.match(seen[0].body, /GetServerTime/)

    mode = 'unauthorized'
    const unauthorized = await api(origin, 'POST', '/connection/test', {})
    assert.equal(unauthorized.body.ok, false)
    assert.equal(unauthorized.body.code, 'AUTH')
    assert.match(unauthorized.body.message, /认证失败/)

    mode = 'keyword'
    const keyword = await api(origin, 'POST', '/connection/test', {})
    assert.equal(keyword.body.ok, false)
    assert.equal(keyword.body.code, 'AUTH')

    // A successful answer that merely contains personal records (with an ID
    // number field) is a pass — the payload must not be read as auth text.
    mode = 'data'
    const withData = await api(origin, 'POST', '/connection/test', {})
    assert.equal(withData.body.ok, true)
    assert.equal(withData.body.code, 'OK')
    assert.doesNotMatch(withData.body.message, /认证失败/)

    // A draft can be tested before saving; the stored secret is not needed.
    const draft = await api(origin, 'POST', '/connection/test', {
      apiUrl: target.base + '/OpenApi/Invoke',
      engineCode: 'DRAFT',
      engineSecret: 'draft-secret',
    })
    assert.equal(draft.body.status, 200)
    assert.equal(seen[seen.length - 1].engineCode, 'DRAFT')

    const unreachable = await probeConnection({
      apiUrl: 'http://127.0.0.1:1/OpenApi/Invoke',
      engineCode: 'x',
      engineSecret: 'y',
    })
    assert.equal(unreachable.ok, false)
    assert.equal(unreachable.code, 'NETWORK')
  } finally {
    await origin.close()
    await target.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('cross-origin callers are refused, same-origin and local callers are not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    const foreign = await fetch(origin.base + '/dsh-cy-api/api/connection', {
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(foreign.status, 403)

    const sameOrigin = await fetch(origin.base + '/dsh-cy-api/api/connection', {
      headers: { origin: origin.base },
    })
    assert.equal(sameOrigin.status, 200)

    const shell = await fetch(origin.base + '/dsh-cy-api/api/connection', {
      headers: { origin: 'dsh-app://app' },
    })
    assert.equal(shell.status, 200)
  } finally {
    await origin.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered APIs are added, updated, listed and removed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    // Start empty: no connection, no APIs.
    let list = await api(origin, 'GET', '/apis')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.apis, [])

    // Add the first API action.
    const added = await api(origin, 'POST', '/apis', {
      name: '查询部门',
      actionName: 'GetDepartmentList',
      controllerName: '',
      description: '列出部门',
      enabled: true,
      params: [
        { name: 'deptId', type: 'string', required: true },
        { name: 'keyword', type: 'string', required: false },
        { name: '', type: 'string', required: false },
      ],
    })
    assert.equal(added.status, 200)
    assert.equal(added.body.apis.length, 1)
    const first = added.body.apis[0]
    assert.equal(first.name, '查询部门')
    assert.equal(first.actionName, 'GetDepartmentList')
    assert.equal(first.enabled, true)
    assert.deepEqual(first.params, [
      { name: 'deptId', type: 'string', required: true },
      { name: 'keyword', type: 'string', required: false },
    ])
    assert.ok(typeof first.id === 'string' && first.id !== '')
    assert.ok(typeof first.createdAt === 'string' && first.createdAt !== '')

    // Add a second one.
    const second = await api(origin, 'POST', '/apis', {
      name: '查询人员',
      actionName: 'GetUserList',
      description: '',
    })
    assert.equal(second.body.apis.length, 2)

    // Update the first one by id.
    const updated = await api(origin, 'POST', '/apis', {
      id: first.id,
      name: '查询部门（已改名）',
      actionName: 'GetDepartmentListV2',
      controllerName: 'Org',
      description: '更新后的说明',
      enabled: false,
    })
    assert.equal(updated.body.apis.length, 2)
    const changed = updated.body.apis.find((item) => item.id === first.id)
    assert.equal(changed.name, '查询部门（已改名）')
    assert.equal(changed.actionName, 'GetDepartmentListV2')
    assert.equal(changed.controllerName, 'Org')
    assert.equal(changed.enabled, false)

    // The file on disk holds the array alongside the (still empty) connection.
    const raw = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))
    assert.equal(Array.isArray(raw.apis), true)
    assert.equal(raw.apis.length, 2)
    assert.equal(raw.connection, null)

    // Remove the first; the second survives.
    const removed = await api(origin, 'DELETE', '/apis', { id: first.id })
    assert.equal(removed.body.apis.length, 1)
    assert.equal(removed.body.apis[0].actionName, 'GetUserList')

    // Removing a non-existent id is a no-op, not an error.
    const gone = await api(origin, 'DELETE', '/apis', { id: 'does-not-exist' })
    assert.equal(gone.status, 200)
    assert.equal(gone.body.apis.length, 1)
  } finally {
    await origin.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid API records are rejected, and old files without apis still load', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    const noName = await api(origin, 'POST', '/apis', { name: '', actionName: 'X' })
    assert.equal(noName.status, 400)
    assert.match(noName.body.error, /接口名称/)

    const noAction = await api(origin, 'POST', '/apis', { name: '仅名字' })
    assert.equal(noAction.status, 400)
    assert.match(noAction.body.error, /ActionName/)
  } finally {
    await origin.close()
  }

  // An old on-disk file that predates the apis field still loads as an empty list.
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, connection: null }, null, 2),
    'utf8',
  )
  const store = new ConnectionStore(dir)
  const payload = await store.read()
  assert.deepEqual(payload.apis, [])
  await rm(dir, { recursive: true, force: true })
})

test('POST /apis/test calls the registered action with connection credentials', async () => {
  const seen = []
  const target = await listen((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        engineCode: req.headers.enginecode,
        engineSecret: req.headers.enginesecret,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Successful: true, ReturnData: { rows: [] } }))
    })
  })
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const origin = await startPluginApi(dir)
  try {
    // Configure the connection.
    await api(origin, 'POST', '/connection', {
      apiUrl: target.base + '/OpenApi/Invoke',
      engineCode: 'ENGINE-1',
      engineSecret: 'secret-1',
    })
    // Register an action with two declared params.
    const added = await api(origin, 'POST', '/apis', {
      name: '查部门',
      actionName: 'GetDepartmentList',
      controllerName: 'Org',
      appCode: 'D00021TestApp',
      params: [
        { name: 'deptId', type: 'string', required: true },
        { name: 'keyword', type: 'string', required: false },
      ],
    })
    const id = added.body.apis[0].id
    assert.equal(added.body.apis[0].appCode, 'D00021TestApp')

    const result = await api(origin, 'POST', '/apis/test', {
      id: id,
      args: { deptId: '100', keyword: '研发' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].engineCode, 'ENGINE-1')
    assert.equal(seen[0].engineSecret, 'secret-1')
    const sent = JSON.parse(seen[0].body)
    assert.equal(sent.ActionName, 'GetDepartmentList')
    assert.equal(sent.Controller, 'Org')
    assert.equal(sent.AppCode, 'D00021TestApp')
    assert.equal(sent.deptId, '100')
    assert.equal(sent.keyword, '研发')
    assert.equal(sent.ControllerName, undefined, 'the wire field is Controller, not ControllerName')

    // Unknown id -> 404.
    const missing = await api(origin, 'POST', '/apis/test', { id: 'nope', args: {} })
    assert.equal(missing.status, 404)
  } finally {
    await origin.close()
    await target.close()
    await rm(dir, { recursive: true, force: true })
  }
})
