import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Point the plugin's data dir at a scratch area before the module is imported,
// so apply() never touches the real ~/.dsh on this machine.
process.env.DSH_HOME = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-tools-'))

const { ConnectionStore, apply } = await import('../lib/index.js')
const { listApiToolDefinition, invokeApiToolDefinition, apiToolDefinition } = (
  await import('../lib/index.js')
).internals

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

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Seed the scratch store: one connection + one enabled and one disabled API. */
async function seedStore() {
  const dir = path.join(process.env.DSH_HOME, 'dsh-cy-api')
  const store = new ConnectionStore(dir)
  await store.save({
    apiUrl: 'https://www.h3yun.com/OpenApi/Invoke',
    engineCode: 'ENGINE-1',
    engineSecret: 'secret-1',
  })
  const added = await store.upsertApi({
    name: '班次管理',
    actionName: 'CreateOneDataPB',
    controllerName: 'MyApiControllerPB',
    appCode: 'D000867TestApp',
    description: '查询班次数据',
    enabled: true,
    params: [
      { name: 'date', type: 'string', required: true },
      { name: 'objectId', type: 'string', required: false },
    ],
  })
  await store.upsertApi({ name: '已停用接口', actionName: 'Off', enabled: false })
  const enabled = added.apis.find((api) => api.name === '班次管理')
  return { store, dir, apiId: enabled.id }
}

test('executeApi calls the endpoint with credentials and returns the parsed payload', async () => {
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
      res.end(JSON.stringify({ Successful: true, ReturnData: { rows: [{ name: '贵阳北' }] } }))
    })
  })
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  try {
    const store = new ConnectionStore(dir)
    await store.save({
      apiUrl: target.base + '/OpenApi/Invoke',
      engineCode: 'ENGINE-1',
      engineSecret: 'secret-1',
    })
    const added = await store.upsertApi({
      name: '班次管理',
      actionName: 'CreateOneDataPB',
      controllerName: 'MyApiControllerPB',
      appCode: 'APP-1',
      enabled: true,
      params: [{ name: 'date', type: 'string', required: true }],
    })
    const id = added.apis[0].id

    const result = await store.executeApi(id, { date: '2026-11-03' })
    assert.deepEqual(result, { Successful: true, ReturnData: { rows: [{ name: '贵阳北' }] } })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].engineCode, 'ENGINE-1')
    assert.equal(seen[0].engineSecret, 'secret-1')
    const sent = JSON.parse(seen[0].body)
    assert.equal(sent.ActionName, 'CreateOneDataPB')
    assert.equal(sent.Controller, 'MyApiControllerPB')
    assert.equal(sent.AppCode, 'APP-1')
    assert.equal(sent.date, '2026-11-03')
  } finally {
    await target.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('executeApi rejects missing, disabled, unauthorised and failed actions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cy-api-'))
  const target = await listen((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ErrorMessage: 'EngineSecret 无效' }))
  })
  try {
    const store = new ConnectionStore(dir)
    await store.save({
      apiUrl: target.base + '/OpenApi/Invoke',
      engineCode: 'E',
      engineSecret: 'S',
    })
    const added = await store.upsertApi({ name: 'A', actionName: 'Act', enabled: true })
    await store.upsertApi({ name: '停用', actionName: 'Off', enabled: false })
    const activeId = added.apis[0].id
    const disabledId = (await store.read()).apis.find((a) => a.name === '停用').id

    await assert.rejects(() => store.executeApi('nope', {}), /未找到该接口记录/)
    await assert.rejects(() => store.executeApi(disabledId, {}), /未启用/)
    await assert.rejects(() => store.executeApi(activeId, {}), /认证失败/)

    // A business failure is reported with the endpoint's message.
    const failedTarget = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Successful: false, ErrorMessage: '参数缺失' }))
    })
    const failedStore = new ConnectionStore(dir)
    // Point a second store at the failing endpoint by editing the record.
    await failedStore.save({
      apiUrl: failedTarget.base + '/OpenApi/Invoke',
      engineCode: 'E',
      engineSecret: 'S',
    })
    await assert.rejects(() => failedStore.executeApi(activeId, {}), /参数缺失/)
    await failedTarget.close()
  } finally {
    await target.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('list/invoke convenience tool definitions expose the right names and schemas', () => {
  const list = listApiToolDefinition({})
  assert.equal(list.name, 'cy_api_dsh_list')
  assert.deepEqual(list.parameters, { type: 'object', additionalProperties: true, properties: {}, required: [] })

  const invoke = invokeApiToolDefinition({})
  assert.equal(invoke.name, 'cy_api_dsh_invoke')
  assert.deepEqual(invoke.parameters.required, ['apiId'])
  assert.ok(invoke.description.includes('cy_api_dsh_list'))

  const api = {
    id: '73ee0ef7-6861-467d-aeb0-677bb6184c85',
    name: '班次管理',
    actionName: 'CreateOneDataPB',
    controllerName: 'MyApiControllerPB',
    params: [
      { name: 'date', type: 'string', required: true },
      { name: 'count', type: 'number', required: false },
    ],
  }
  const direct = apiToolDefinition(api, {})
  assert.equal(direct.name, 'cy_api_dsh_73ee0ef76861467daeb0677bb6184c85')
  assert.equal(direct.parameters.required[0], 'date')
  assert.equal(direct.parameters.properties.date.type, 'string')
  assert.equal(direct.parameters.properties.count.type, 'number')
  assert.equal(direct.parameters.additionalProperties, true)
  assert.ok(direct.description.includes('班次管理'))
})

test('tool execute resolves via the store and returns data', async () => {
  const calls = []
  const store = {
    read: async () => ({
      connection: { apiUrl: 'x' },
      apis: [{ id: 'a1', name: '班次', actionName: 'A', enabled: true, params: [] }],
    }),
    executeApi: async (id, args) => {
      calls.push({ id, args })
      return { ok: true }
    },
  }

  const list = listApiToolDefinition(store)
  const listed = await list.execute({})
  assert.equal(listed.connectionConfigured, true)
  assert.equal(listed.apis[0].name, '班次')

  const invoke = invokeApiToolDefinition(store)
  const result = await invoke.execute({ apiId: 'a1', date: '2026-11-03' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [{ id: 'a1', args: { date: '2026-11-03' } }])
  await assert.rejects(() => invoke.execute({}), /缺少 apiId/)
})

test('apply registers list/invoke tools, per-interface tools and a system prompt hint', async () => {
  const { store, apiId } = await seedStore()
  const registered = []
  const systemPatches = []
  const ctx = {
    get: () => undefined,
    logger: () => ({ warn: () => {} }),
    inject: (_deps, cb) => {
      const child = {
        logger: () => ({ warn: () => {} }),
        effect: (fn) => fn(),
        tools: {
          register: (def) => {
            registered.push(def.name)
            return () => {}
          },
        },
        systemPrompt: {
          set patch(fn) {
            systemPatches.push(fn)
          },
        },
        webServer: { register: () => () => {} },
      }
      cb(child)
    },
  }

  apply(ctx)

  // The per-interface convenience tools are registered after an async store
  // read settles; poll briefly instead of guessing the event-loop turns.
  const want = `cy_api_dsh_${apiId.replace(/[^a-z0-9]/gi, '')}`
  for (let i = 0; i < 100 && !registered.includes(want); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  assert.ok(registered.includes('cy_api_dsh_list'), 'list tool registered')
  assert.ok(registered.includes('cy_api_dsh_invoke'), 'invoke tool registered')
  assert.ok(registered.includes(want), 'enabled interface gets a convenience tool')

  // No tool should be registered for the disabled interface.
  const state = await store.read()
  const disabled = state.apis.find((api) => api.name === '已停用接口')
  assert.ok(disabled, 'disabled interface exists')
  assert.ok(
    !registered.includes(`cy_api_dsh_${disabled.id.replace(/[^a-z0-9]/gi, '')}`),
    'disabled interface has no tool',
  )

  assert.equal(systemPatches.length, 1, 'one system prompt patch applied')
  const patched = systemPatches[0]('')
  assert.ok(patched.includes('cy_api_dsh_list'))
  assert.ok(patched.includes('敏感凭据'))
})
