# dsh-cy-api

把 HTTP 接口转成 DeepSeek Harness（DSH）里的可调用能力。**当前版本 v2026.11.13.1**，已交付：全局注入的「接口 + 组织架构凭据」配置页（唯一连接），以及在这份连接之上登记多个可调用接口动作的「数据调用」登记表。

> 版本声明：`package.json` 中写作 `"version": "2026.11.13.1"`（npm 语义化版本不允许 `v` 前缀；本版是四段式补丁号，`npm pack` 已实测接受），git tag 与 GitHub Release 使用 `v2026.11.13.1`。

## 两类数据：一条连接 + 多张接口登记表

连接凭据**仍然全局唯一一份**（`connection` 对象，不是数组）；但它之上可以登记**多条接口动作**（`apis` 数组）——每条就是氚云 OpenApi 的一个 `ActionName`，已启用的会自动注册成 DSH 工具供模型按意图调用。连接与接口是两个顶层字段，互不阻塞：可以先登记接口再配连接，也可以不配连接先把清单列好。

| 字段 | 唯一性 |
| --- | --- |
| 接口地址（`apiUrl`） | 唯一，且会被规范化（去尾斜杠、统一大小写与默认端口），一个地址只有一种写法 |
| EngineCode | 唯一 |
| EngineSecret | 唯一，AES-256-GCM 加密后落盘，永不返回明文 |
| `apis[]`（接口动作） | 多条，每条有自己的 `id` / `name` / `appCode` / `actionName` / `controllerName` / `description` / `enabled` / `params[]`；AppCode 按接口各自填写 |

「唯一」是结构保证，不是保存时去重：

- 数据文件是 `{ "version": 1, "connection": { ... } }`，`connection` 是一个对象，**不是数组**，写不出第二条；
- 保存（`POST /connection`）是整条覆盖，不是追加；
- 所有读改写走同一条串行队列，不会被并发写出两份；
- `GET /connection` 返回的永远是 `null` 或一个对象，`/diagnostics` 里的 `connections` 恒为 `0` 或 `1`。

## 顶部导航：标签按钮切换页面

页面顶部是一条导航栏（`role="tablist"`），里面是一个个标签按钮，点哪个就切换成哪一页；当前页签有品牌色下划线，也支持 `←` / `→` 键在页签之间切换。页签状态记在模块作用域里，离开页面再回来仍停在原来那一页。

| 页签 | 内容 |
| --- | --- |
| **接口配置** | 固定页面：三项唯一字段的表单、保存、测试连接、清除 |
| **数据调用** | 接口登记表：在这份连接之上增/删/改多个接口动作（名称、ActionName、ControllerName、用途说明、是否启用），并展示宿主函数 / HTTP 接口 / 当前记录原文 |
| **版本更新** | 从 GitHub 仓库检查是否有新版本：当前版本、最新版本、发布页链接；进入页签自动检查一次，也可手动重查 |

加一页只需要在 `lib/client.js` 的 `TABS` 里加一行，再在 `connectionPanel()` / `dataPanel()` 旁边加一个渲染函数：

```js
var TABS = [
  { id: 'connection', labelKey: 'tabConnection' },
  { id: 'data', labelKey: 'tabData' },
  // { id: 'org', labelKey: 'tabOrg' },
]
```

页签按钮带 `role="tab"`、`aria-selected`、`aria-controls`，内容区带 `role="tabpanel"`，键盘与读屏软件都能正常识别。

## 这个页面是「全局」的，不是设置项

管理页面不挂在 **设置** 里，也不属于任何会话。它由两个 root 作用域的槽注册组成：

| 槽 | 作用 |
| --- | --- |
| `sidebar.panellist` | 左侧边栏的入口（`id: dsh-cy-api`） |
| `main`（keyed） | 点入口后打开的全局面板（`key: dsh-cy-api`） |

这正是 DSH 自带 **Plugins** 页面使用的方式：页面是全局的、属于应用而不属于某个会话，切换会话不会离开它。两者都用 `ctx.slots.inject()` 注册，因此跟随槽的声明、语言切换和卸载。

## 后续怎么调用这份数据

页面上的配置，后续功能**直接读同一份记录**，不需要页面参与。页面上也把这一小段原样展示出来了：

宿主侧（工具、定时任务、脚本，同进程）：

```js
import { readConnection, resolveCredentials } from 'dsh-cy-api/index.js'

const { connection } = await readConnection()
// { apiUrl, engineCode, secretSet, createdAt, updatedAt } | null

const { apiUrl, engineCode, engineSecret } = await resolveCredentials()
// 含解密后的 EngineSecret；未配置时抛错
```

跨进程 / 外部脚本：

```
GET /dsh-cy-api/api/connection
```

返回结构与页面展示完全一致（不含明文密钥，`secretSet` 表示是否已保存）。**页面只是这份唯一数据的编辑入口，数据本身不依赖页面是否打开。**

## 功能（v2026.11.13.1）

- 侧边栏新增 **API 转 DSH** 入口，点开就是插件页面
- **顶部导航**：标签按钮在「接口配置」与「数据调用」两页之间切换，带下划线与键盘支持
- 三项唯一字段的新增 / 修改 / 清除，无列表、无重复
- **测试连接**：由宿主用当前填写（或已保存）的地址与凭据真实发一次探针，显示状态码、耗时、判定结论与响应预览
- 探针按氚云 OpenApi 的方式发送：`POST <接口地址>`，请求头带 `EngineCode` / `EngineSecret`，请求体 `{"ActionName":"GetServerTime","ControllerName":""}`；判定顺序为 `401/403` → 认证类文案 → 平台到期 / 地址不存在 → HTTP 失败 → 通过
- **认证判定只读服务端自己的错误文案**（`ErrorMessage` / `Message` / `ReturnData.message` / `OpenApiError.ErrorMessage` 等），业务响应正文不参与关键词匹配；`Successful: true` 的响应直接判通过——数据里出现「身份证号」「权限」这类字段名不会被误读成认证失败（v2026.11.13 修复）
- **接口登记表**：「数据调用」页可在唯一连接之上增 / 删 / 改多条接口动作（名称、ActionName、ControllerName、用途说明、是否启用、自定义参数名/类型/必填），与连接一起落盘
- **独立编辑页**：点「新增接口」/「编辑接口」会切换到一个独立的全屏编辑页（不在列表里展开表单）；保存成功后自动回到「数据调用」列表，点「返回」可手动返回
- **测试该接口**：每条接口旁有「测试」按钮，展开后按它声明的参数填入本次测试值，宿主用已保存的连接凭据真实发一次请求，回显状态码、耗时、判定结论与 Pretty JSON 响应预览；请求体按氚云自定义接口格式拼成 `{ActionName, Controller, AppCode, ...参数值}`；响应预览只保留前 600 字符，超出时后缀标注「共 N 字节，预览已截断」，不会把整份业务数据铺到页面上
- 只读回显：页面直接展示 `GET /connection` 的返回内容与更新时间、存储位置
- 中文 / 英文双语（走 DSH 的 locale 服务）

## 目录结构

```
dsh-cy-api/
├── package.json          # 名称 dsh-cy-api、版本 2026.11.13.1、dsh.bundle / dsh.client 声明
├── cordis.patch.yml      # bundle 层：插入 dsh-cy-api 这一行
├── icon.svg              # 插件图标
├── locale/
│   ├── zh.json           # 插件清单显示名与说明（中文）
│   └── en.json           # 同上（英文）
├── lib/
│   ├── index.js          # 宿主半：唯一记录存储、加密、探针、JSON 接口、对外读取函数
│   └── client.js         # 浏览器半：ModuleLoader 工厂 + 全局固定页面与侧边栏入口
└── test/
    ├── host.test.mjs     # 唯一性、加密、探针分类、非法输入、跨站拒绝
    └── client.test.mjs   # 槽注册与页面渲染（用 React 替身跑真实 bundle）
```

`lib/client.js` 是手写 bundle，沿用 DSH 客户端模块系统的格式（`window.__ModuleLoader__.load({ id, factory })`），只从浏览器模块表取 `react`，因此**零运行时依赖、无需构建**。`lib/index.js` 同样零依赖（只用 Node 内建模块）。

## 数据

| 项目 | 位置 / 方式 |
| --- | --- |
| 数据库 | `%DSH_HOME%\dsh-cy-api\config.json`（默认 `C:\Users\<你>\.dsh\dsh-cy-api\`） |
| 格式 | `{ "version": 1, "connection": { ... } \| null }`，原子写入（临时文件 + rename），权限 0600 |
| 加密密钥 | 同目录 `secret.key`，32 字节随机数，权限 0600 |
| 加密算法 | AES-256-GCM，密文格式 `v1.<iv>.<tag>.<ciphertext>`（base64url） |
| 明文项 | `apiUrl`、`engineCode`（用于展示与调用，非机密） |

单条记录：

```json
{
  "version": 1,
  "connection": {
    "apiUrl": "https://www.h3yun.com/OpenApi/Invoke",
    "engineCode": "ENGINE-xxxx",
    "engineSecret": "v1.<iv>.<tag>.<ciphertext>",
    "createdAt": "2026-10-28T02:00:00.000Z",
    "updatedAt": "2026-10-28T02:05:00.000Z"
  },
  "apis": [
    {
      "id": "9f1c…",
      "name": "查询部门列表",
      "appCode": "D00021xxxx",
      "actionName": "GetDepartmentList",
      "controllerName": "",
      "description": "拉取组织架构下的全部部门",
      "enabled": true,
      "params": [
        { "name": "deptId", "type": "string", "required": true },
        { "name": "keyword", "type": "string", "required": false }
      ],
      "createdAt": "2026-10-28T02:10:00.000Z",
      "updatedAt": "2026-10-28T02:10:00.000Z"
    }
  ]
}
```

读到无法解析的文件时不会覆盖，而是改名成 `config.json.corrupt-<时间戳>` 留档，然后从「未配置」开始。

## 接口

宿主注册了前缀路由 `/dsh-cy-api/api`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/connection` | 读取唯一的配置（安全视图，无明文密钥） |
| POST / PUT | `/connection` | 保存，整条覆盖；**EngineSecret 留空表示保持原值** |
| DELETE | `/connection` | 清除配置，回到未配置状态 |
| POST | `/connection/test` | 连接测试；可带草稿（`apiUrl` / `engineCode` / `engineSecret`）先测试后保存 |
| GET | `/apis` | 列出已登记的全部接口动作（随 `connection` 一起返回） |
| POST | `/apis` | 新增或更新一条接口；带 `id` 即更新，不带即新增 |
| DELETE | `/apis` | 删除一条接口，body 带 `{ id }` |
| POST | `/apis/test` | 用已保存的连接凭据真实调用一次该接口，body 带 `{ id, args }`（参数值仅本次测试） |
| GET | `/diagnostics` | 插件状态、版本、`connections: 0\|1`、`apiCount`、客户端 bundle 路径与启动图行 |
| GET | `/version` | 检查 GitHub 仓库的最新发布版本：优先 latest release，无 release 时回退最高 tag；返回 `currentVersion` / `latestVersion` / `hasUpdate` / `releaseUrl` / `source` / `checkedAt`，`error` 为空表示成功 |

### 访问控制

- 只接受本机来源：回环地址，或桌面外壳的同进程派发（没有 socket 的请求不可能是网络请求）
- 显式带了网页 `Origin` 的跨站请求一律拒绝，即使来源是本机 —— 否则本机任意页面都能改写这份凭据
- 桌面外壳的 `dsh-app://app` 与非 http(s) 外壳协议按本机规则放行
- 所有响应带 `cache-control: no-store`，请求体上限 256 KiB

## DSH 工具

宿主把已登记且 `enabled: true` 的接口动作注册成模型可调用的工具（`ctx.tools.register`），并注入一段系统提示说明用法。模型（含钉钉 / IM 机器人）即可按意图调用接口并拿到数据：

| 工具 | 作用 |
| --- | --- |
| `cy_api_dsh_list` | 列出已登记的接口清单（id、名称、动作、控制器、参数要求），调用前先看它 |
| `cy_api_dsh_invoke` | 按接口 `id` + 业务参数调用任意已登记接口，返回数据 |
| `cy_api_dsh_<接口id>` | 每个已启用接口的便捷工具，可按名称直接调用 |

- 执行走 `ConnectionStore.executeApi()`：用存储中的加密凭据调氚云 OpenApi，返回**完整业务数据**（不是测试用的认证分类）；凭据只用于请求头，绝不进入工具结果
- 运行中新增 / 启用接口后，`cy_api_dsh_list` / `cy_api_dsh_invoke` 立即可用（execute 时才读清单）；便捷工具需触碰 `cordis.patch.yml` 触发重载后生成
- 系统提示明确：EngineCode / EngineSecret、账号密码等敏感凭据不通过对话输出（模型对敏感数据的输出行为由其自身安全判断决定，插件不代为绕过）

## 版本更新检查

「版本更新」页签从上游 GitHub 仓库检查是否有新版本：

| 项 | 说明 |
| --- | --- |
| 数据来源 | 优先 `GET /repos/Jydsh/dsh-cy-api/releases/latest`；仓库还没有 Release（404）时回退到 `GET .../tags`，取版本号最大的 tag |
| 当前版本 | 读本插件 `package.json` 的 `version` |
| 版本比较 | 逐段数字比较，忽略 tag 的 `v` 前缀（`v2026.11.05` 与 `2026.11.5` 视为同一版本） |
| 触发方式 | 进入页签自动检查一次；按钮「检查更新」可随时重查 |
| 无发布版本 | 仓库既无 Release 也无 tag 时显示「仓库暂无发布版本」，这不是错误 |
| 失败处理 | 网络 / 超时 / 解析失败不抛异常，页面显示「检查失败：<原因>」，可重试 |

宿主对应接口是 `GET /dsh-cy-api/api/version`，实现细节：

- 请求带 `user-agent` 与 GitHub API 版本头，8 秒超时（`AbortController`）
- 结果在进程内缓存 60 秒，避免反复触发 GitHub 未认证限流（60 次/小时）
- 可选：设置环境变量 `GITHUB_TOKEN` 后请求会带 `authorization: Bearer`，提升限流额度
- `checkForUpdates()` 可注入 `fetchImpl` / `baseUrl` / `currentVersion`，便于离线测试

## 安装

运行要求：**Node.js ≥ 20** 与 **pnpm**（DSH 的 profile 用 pnpm 管理依赖）。

插件通过 DSH 的 profile 机制加载：把 `dsh-cy-api` 加入 profile 的 `dependencies`，再把 `dsh-cy-api` 加入 `dsh.profile.bundles`。桌面版与 Web 环境只是 profile 目录不同，安装命令一致。

### 桌面版（Windows / macOS 客户端）

profile 目录：Windows 为 `%USERPROFILE%\.dsh\profiles\desktop`，macOS 为 `~/.dsh/profiles/desktop`。

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "github:Jydsh/dsh-cy-api#v2026.11.13.1"
```

### Web 环境（DSH Web 服务）

profile 目录在 Web 实例的数据目录下，即 `$DSH_HOME/profiles/<profile 名>`（按实际部署填写，常见为 `profiles/web`）。

```bash
cd "${DSH_HOME}/profiles/web"
pnpm add "github:Jydsh/dsh-cy-api#v2026.11.13.1"
```

### 之后都要做的一步

确认 profile 的 `package.json` 里有：

```jsonc
// package.json
"dependencies": { "dsh-cy-api": "github:Jydsh/dsh-cy-api#v2026.11.13.1" },
"dsh": { "profile": { "bundles": [ ..., "dsh-cy-api" ] } }
```

然后**完全退出并重启 DSH**。bundle 名单变化后热重载不保证生效，必须重启进程。

### 本地开发安装（不走 GitHub）

```powershell
pnpm add "dsh-cy-api@link:E:\dsh-cy-api"
```

profile 的 `node_modules\dsh-cy-api` 会是指向源码目录的 junction：改 `lib/index.js` 后触碰 profile 的 `cordis.patch.yml`（哪怕只加一行注释）触发重载，改 `lib/client.js` 后刷新页面即可。

### 卸载

```powershell
pnpm remove dsh-cy-api
```

并从 `dsh.profile.bundles` 里删掉 `dsh-cy-api`。

## 开发

```powershell
# 四个测试文件，共 33 个用例
node --test test/*.test.mjs
```

- `test/host.test.mjs` 起真实 HTTP 服务，验证地址规范化、唯一性（保存即覆盖、文件里只有一个对象）、密文不落明文、解密读回、清除、非法输入、探针对凭据与认证/网络错误的分类、跨站拒绝
- `test/client.test.mjs` 用 React 替身执行**真实的** `lib/client.js`：断言两个槽注册、id/key 对齐、中英文字典键一致、页签渲染与点击切换、方向键切换、三个页签各自的渲染、侧边栏图标尺寸、独立编辑页
- `test/tools.test.mjs` 验证 `executeApi` 真实调用与错误分类、`list`/`invoke`/便捷工具的定义（名称、参数 schema）、工具 execute 经 store 取数、`apply` 注册工具与系统提示注入
- `test/version.test.mjs` 用注入的假 `fetch` 验证版本号比较（含 `v` 前缀 / 前导零）、有 Release 时取 Release、无 Release 回退最高 tag、空仓库「暂无发布版本」、网络失败不抛异常、`GET /version` 路由结构

## 下一步

登记表已经把"要调哪些接口"列好了，接口也已注册成 DSH 工具；接下来：

1. 工具注册状态（成功 / 失败 / 参数 schema）回显在「数据调用」页每条接口上
2. v2026.11.13.1 已发布到 GitHub（tag / Release），「版本更新」页签现在显示真实的最新版本

## 已知限制

- 便捷工具（`cy_api_dsh_<接口id>`）在插件加载时按当时清单生成；运行中新增 / 启用接口需触碰 `cordis.patch.yml` 触发重载后才会有对应便捷工具（`cy_api_dsh_list` / `cy_api_dsh_invoke` 不受影响，execute 时才读清单）
- 测试时的参数值只在本次请求里使用，不落盘、不做 schema 校验；必填参数留空仍会发出，由接口端报错
- 登记表不校验 ActionName 是否真实存在；调用时由氚云接口端报错
- 探针固定使用氚云 OpenApi 的 `GetServerTime` 动作；换成别的平台时需要改探针
- 密钥与数据库放在同一目录：能同时读取两者的本机进程可以解密。这防的是配置误传、备份泄露和日志泄露，不是同机同用户的恶意进程
- 页面在真实浏览器里的渲染仍需人工确认（本机无浏览器控制通道）；宿主接口、bundle 服务与启动图已实测通过

## 更新记录

| 版本 | 内容 |
| --- | --- |
| `v2026.11.13.1` | 版本号补丁发布：本次无功能代码变更，仅递增版本号并同步文档；用途是让「版本更新」页签与 `GET /version` 能识别出一个高于 `2026.11.13` 的新版本，验证升级提示链路 |
| `v2026.11.13` | 修复「认证失败」误判：`ErrorMessage` 为空时不再把整份响应正文当错误文案，认证判定改为「只读服务端自有文案 + `Successful:true` 直接放行」，正则里裸匹配的「身份」收窄为「身份验证 / 身份认证 / 身份校验」；响应预览截断到 600 字符并标注总字节数；`Successful:false` 时探针明确回报「认证通过，但接口调用返回失败」而不是认证失败 |
| `v2026.11.12` | 「版本更新」页签 + GitHub 版本检查（`GET /version`，优先 latest release、无 Release 回退最高 tag） |
| `v2026.11.05` | 首个发布版本：唯一连接 + 多接口登记、独立编辑页、接口转 DSH 工具、中英双语 |
