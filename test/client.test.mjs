/**
 * Exercises the real browser bundle without a browser: the ModuleLoader factory
 * runs against a minimal React stand-in, and the slot registrations are captured
 * so the global page wiring and the tabbed render path are both checked.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** Minimal React: enough to execute a component function once. */
function createReact(overrides = []) {
  const pending = overrides.slice()
  const setters = []
  function createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  }
  return {
    setters,
    createElement,
    useState(initial) {
      const next = pending.length > 0 ? pending.shift() : initial
      return [
        next,
        (value) => {
          setters.push(typeof value === 'function' ? value(next) : value)
        },
      ]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
  }
}

/** Load the bundle and return the module its factory produces. */
async function loadClient(React) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  // The bundle is a plain script that touches `window` at top level.
  new Function('window', source)(fakeWindow)
  assert.ok(captured !== null, 'the bundle must register a ModuleLoader factory')
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  return { spec: captured, module: captured.factory(require) }
}

/** Walk the rendered tree, collecting elements that match. */
function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  if (typeof node.type === 'function') {
    collect(node.type(node.props), predicate, found)
  } else {
    collect(node.children, predicate, found)
  }
  return found
}

/** Flatten a rendered element tree into its visible text. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.children)
}

/** Run the plugin's apply with recording services. */
async function applyPlugin(React, language = 'zh') {
  const { spec, module } = await loadClient(React)
  const registrations = []
  const injections = []
  let dictionaries = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register(namespace, dict) {
        dictionaries = { namespace, dict }
        return () => {}
      },
      bind() {
        return (key) => (dictionaries && dictionaries.dict[language] && dictionaries.dict[language][key]) || key
      },
    },
    slots: {
      inject(ownerKey, factory) {
        injections.push(ownerKey)
        factory()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  const t = (key) =>
    (dictionaries && dictionaries.dict[language] && dictionaries.dict[language][key]) || key
  return { spec, module, registrations, injections, dictionaries, t }
}

/**
 * State cells in declaration order, for one render:
 * data, loading, error, notice, busy, form, confirmClear, testResult, tab,
 * apiForm, apiBusy, confirmDeleteId, testingId, testArgs, apiTestResult, apiTestBusy.
 */
function stateOverrides(data, extra = {}) {
  return [
    data,
    false,
    extra.error ?? '',
    extra.notice ?? '',
    extra.busy ?? '',
    extra.form ?? { apiUrl: '', engineCode: '', engineSecret: '' },
    false,
    null,
    extra.tab ?? 'connection',
    extra.apiForm ?? null,
    false,
    extra.confirmDeleteId ?? '',
    extra.testingId ?? '',
    extra.testArgs ?? {},
    extra.apiTestResult ?? null,
    false,
  ]
}

const CONFIGURED = {
  version: '0.0.0',
  storage: 'C:\\Users\\x\\.dsh\\dsh-cy-api',
  connection: {
    apiUrl: 'https://www.h3yun.com/OpenApi/Invoke',
    engineCode: 'ENGINE-1',
    secretSet: true,
    createdAt: '2026-10-28T02:00:00.000Z',
    updatedAt: '2026-10-28T02:05:00.000Z',
  },
}

const EMPTY = { version: '0.0.0', storage: 'C:\\Users\\x\\.dsh\\dsh-cy-api', connection: null }

function pageOf(registrations) {
  return registrations.find((entry) => entry.options.name === 'main')
}

function tabsOf(tree) {
  return collect(tree, (node) => node.type === 'button' && node.props.role === 'tab')
}

test('the bundle declares the expected module id and services', async () => {
  const { spec, module, injections } = await applyPlugin(createReact())
  assert.equal(spec.id, 'dsh-cy-api')
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.deepEqual(injections, ['main', 'sidebar.panellist'])
})

test('the page is injected globally: a keyed main panel plus its sidebar entry', async () => {
  const { registrations, dictionaries } = await applyPlugin(createReact())
  assert.equal(registrations.length, 2)

  const panel = pageOf(registrations)
  assert.ok(panel, 'a main panel registration is required')
  // The layout addresses the panel by `key`; the sidebar entry by `id`.
  assert.equal(panel.options.key, 'dsh-cy-api')
  assert.equal(panel.options.locale, 'dshCyApi')
  assert.equal(typeof panel.component, 'function')

  const entry = registrations.find((item) => item.options.name === 'sidebar.panellist')
  assert.ok(entry, 'a sidebar.panellist registration is required')
  assert.equal(entry.options.id, panel.options.key)
  assert.equal(entry.options.locale, 'dshCyApi')
  assert.equal(typeof entry.options.order, 'number')
  assert.equal(entry.options.label(), 'API 转 DSH')

  assert.equal(dictionaries.namespace, 'dshCyApi')
  assert.ok(dictionaries.dict.zh && dictionaries.dict.en)
  assert.deepEqual(
    Object.keys(dictionaries.dict.zh).sort(),
    Object.keys(dictionaries.dict.en).sort(),
    'both dictionaries must define the same keys',
  )
})

test('the top navigation renders one tab button per page', async () => {
  const { registrations, t } = await applyPlugin(createReact(stateOverrides(CONFIGURED)))
  const tree = pageOf(registrations).component({ t })

  const tablist = collect(tree, (node) => node.props.role === 'tablist')
  assert.equal(tablist.length, 1, 'there must be exactly one tab list')
  assert.equal(tablist[0].props['aria-label'], '页面导航')

  const tabs = tabsOf(tree)
  assert.deepEqual(
    tabs.map((node) => textOf(node)),
    ['接口配置', '数据调用', '版本更新'],
  )
  assert.deepEqual(
    tabs.map((node) => node.props['aria-selected']),
    ['true', 'false', 'false'],
    'the first page is selected by default',
  )
  assert.deepEqual(
    tabs.map((node) => node.props['aria-controls']),
    ['dsh-cy-api-panel-connection', 'dsh-cy-api-panel-data', 'dsh-cy-api-panel-update'],
  )
})

test('clicking a tab button switches the page', async () => {
  const React = createReact(stateOverrides(CONFIGURED))
  const { registrations, t } = await applyPlugin(React)
  const tree = pageOf(registrations).component({ t })

  const dataTab = tabsOf(tree).find((node) => textOf(node) === '数据调用')
  assert.ok(dataTab, 'the data tab must exist')
  dataTab.props.onClick()
  assert.deepEqual(React.setters, ['data'], 'clicking the tab must select the data page')
})

test('arrow keys move the selection along the navigation', async () => {
  // Each render starts from a fixed selection, so the handler is checked from
  // both ends instead of relying on a re-render the stand-in does not perform.
  const forward = createReact(stateOverrides(CONFIGURED, { tab: 'connection' }))
  const forwardTree = pageOf((await applyPlugin(forward)).registrations).component({
    t: (key) => key,
  })
  collect(forwardTree, (node) => node.props.role === 'tablist')[0].props.onKeyDown({ key: 'ArrowRight' })
  assert.deepEqual(forward.setters, ['data'])

  const backward = createReact(stateOverrides(CONFIGURED, { tab: 'data' }))
  const backwardTree = pageOf((await applyPlugin(backward)).registrations).component({
    t: (key) => key,
  })
  collect(backwardTree, (node) => node.props.role === 'tablist')[0].props.onKeyDown({ key: 'ArrowLeft' })
  // Keys the navigation does not own must not change the page.
  collect(backwardTree, (node) => node.props.role === 'tablist')[0].props.onKeyDown({ key: 'Tab' })
  assert.deepEqual(backward.setters, ['connection'])
})

test('the fixed form is the first page', async () => {
  const { registrations, t } = await applyPlugin(createReact(stateOverrides(EMPTY)))
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /全局页面/)
  assert.match(text, /固定页面/)
  assert.match(text, /未配置/)
  assert.match(text, /接口地址/)
  assert.match(text, /EngineCode/)
  assert.match(text, /EngineSecret/)
  assert.match(text, /保存配置/)
  assert.match(text, /测试连接/)
  // The data page is not mounted while the first tab is selected.
  assert.doesNotMatch(text, /readConnection/)
})

test('the data page shows how later code reads the single record', async () => {
  const { registrations, t } = await applyPlugin(
    createReact(stateOverrides(CONFIGURED, { tab: 'data' })),
  )
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /readConnection/)
  assert.match(text, /resolveCredentials/)
  assert.match(text, /GET \/dsh-cy-api\/api\/connection/)
  assert.match(text, /"secretSet": true/)
  assert.match(text, /https:\/\/www\.h3yun\.com\/OpenApi\/Invoke/)
  assert.match(text, /ENGINE-1/)
  // The form lives on the other page.
  assert.doesNotMatch(text, /保存配置/)
})

test('an unconfigured data page says so instead of inventing fields', async () => {
  const { registrations, t } = await applyPlugin(createReact(stateOverrides(EMPTY, { tab: 'data' })))
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /还没有保存配置/)
  assert.match(text, /"connection": null/)
  assert.doesNotMatch(text, /super-secret/)
})

test('the navigation and both pages render in English', async () => {
  const { registrations, t } = await applyPlugin(
    createReact(stateOverrides(CONFIGURED, { tab: 'data' })),
    'en',
  )
  const tree = pageOf(registrations).component({ t })
  assert.deepEqual(
    tabsOf(tree).map((node) => textOf(node)),
    ['Endpoint', 'Data access', 'Version'],
  )
  const text = textOf(tree)
  assert.match(text, /Global page/)
  assert.match(text, /Fixed page/)
  assert.match(text, /Registered APIs/)
})

test('the sidebar icon renders an svg at the requested size', async () => {
  const { registrations } = await applyPlugin(createReact())
  const entry = registrations.find((item) => item.options.name === 'sidebar.panellist')
  const icon = entry.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
  assert.equal(icon.props.height, 18)
  assert.equal(icon.props['aria-hidden'], true)
})

const WITH_APIS = {
  version: '0.0.0',
  storage: 'C:\\Users\\x\\.dsh\\dsh-cy-api',
  connection: {
    apiUrl: 'https://www.h3yun.com/OpenApi/Invoke',
    engineCode: 'ENGINE-1',
    secretSet: true,
    createdAt: '2026-10-28T02:00:00.000Z',
    updatedAt: '2026-10-28T02:05:00.000Z',
  },
  apis: [
    {
      id: 'api-1',
      name: '查询部门',
      actionName: 'GetDepartmentList',
      controllerName: '',
      appCode: 'D00021AppOne',
      description: '列出部门',
      enabled: true,
      params: [
        { name: 'deptId', type: 'string', required: true },
        { name: 'keyword', type: 'string', required: false },
      ],
      createdAt: '2026-10-28T02:00:00.000Z',
      updatedAt: '2026-10-28T02:00:00.000Z',
    },
    {
      id: 'api-2',
      name: '查询人员',
      actionName: 'GetUserList',
      controllerName: 'Org',
      description: '',
      enabled: false,
      params: [],
      createdAt: '2026-10-28T02:00:00.000Z',
      updatedAt: '2026-10-28T02:05:00.000Z',
    },
  ],
}

test('the data page renders the registered API list', async () => {
  const { registrations, t } = await applyPlugin(createReact(stateOverrides(WITH_APIS, { tab: 'data' })))
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /已登记接口/)
  assert.match(text, /查询部门/)
  assert.match(text, /查询人员/)
  assert.match(text, /GetDepartmentList/)
  assert.match(text, /GetUserList/)
  assert.match(text, /Controller=Org/)
  assert.match(text, /\*deptId：string/)
  assert.match(text, /新增接口/)
  assert.match(text, /编辑/)
  assert.match(text, /删除/)
})

test('the data page says so when no API is registered yet', async () => {
  const empty = { ...EMPTY, apis: [] }
  const { registrations, t } = await applyPlugin(createReact(stateOverrides(empty, { tab: 'data' })))
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /还没有登记接口/)
  assert.match(text, /新增接口/)
})

test('opening the editor shows the API form fields on a standalone page', async () => {
  const editing = {
    id: 'api-1',
    name: '查询部门',
    actionName: 'GetDepartmentList',
    controllerName: '',
    description: '列出部门',
    enabled: true,
  }
  const { registrations, t } = await applyPlugin(
    createReact(stateOverrides(WITH_APIS, { tab: 'data', apiForm: editing })),
  )
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /编辑接口/)
  assert.match(text, /接口名称/)
  assert.match(text, /ActionName/)
  assert.match(text, /ControllerName/)
  assert.match(text, /用途说明/)
  assert.match(text, /参数/)
  assert.match(text, /添加参数/)
  assert.match(text, /保存接口/)
  // The editor is a separate page: neither the list nor the connection form
  // is rendered while editing.
  assert.doesNotMatch(text, /已登记接口/)
  assert.doesNotMatch(text, /保存配置/)
})

test('a blank editor is the standalone “add” page', async () => {
  const blank = {
    id: '',
    name: '',
    appCode: '',
    actionName: '',
    controllerName: '',
    description: '',
    enabled: true,
    params: [],
  }
  const { registrations, t } = await applyPlugin(
    createReact(stateOverrides(WITH_APIS, { tab: 'data', apiForm: blank })),
  )
  const text = textOf(pageOf(registrations).component({ t }))

  assert.match(text, /新增接口/)
  assert.match(text, /接口名称/)
  assert.match(text, /返回/)
  // The list and the tabs are hidden: this is a full-page editor, not an
  // inline expansion inside the data page.
  assert.doesNotMatch(text, /已登记接口/)
  assert.doesNotMatch(text, /接口配置/)
})
