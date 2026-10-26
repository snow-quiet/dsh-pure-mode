/**
 * dsh-pure-mode — 纯净模式
 *
 * 只装配用户自己的提示词：
 *   - 系统提示词：只有 pure:prompt 这一段（complete 语义 + 最外层方法级清洗）
 *   - 运行时上下文：全部抑制 + 最外层清洗（cwd 那一行也不留）
 *   - 工具 schema：装配结果里直接清空（模型拿不到任何工具）
 *
 * 三层防线（从里到外）：
 *   ① section({ complete: true })   —— 官方 assemble 保证它是唯一段
 *   ② system-prompt/assemble 清洗    —— waterfall 最外层，压掉第三方段
 *   ③ assemble 方法级包装            —— 跑在 dsh-purge 的 assemble guard 外面
 *
 * 提示词来源（优先级从高到低）：
 *   1. <DSH_HOME>/pure-mode/prompts/<sessionId>.md   会话级
 *   2. <DSH_HOME>/pure-prompt.md                    全局
 *   3. 空                                           真正的零系统提示词
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Cordis 插件名。 */
export const name = 'pure-mode'

/** 需要宿主平面的提示词注册表。 */
export const inject = ['systemPrompt']

/** 本插件注册的唯一段名。 */
const SECTION = 'pure:prompt'

/** dsh-purge 的"停火协议"槽（全局符号注册表，双方拿到同一个）。 */
const PURGE_SLOT = Symbol.for('dsh-purge.assembleGuard')

/** 我们自己的标记，避免重复包装。 */
const PURE_SLOT = Symbol.for('dsh-pure-mode.assembleGuard')

/** $DSH_HOME，缺省 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 全局提示词文件。 */
export function globalPromptFile() {
  return path.join(dshHome(), 'pure-prompt.md')
}

/** 会话级提示词文件。 */
export function sessionPromptFile(sessionId) {
  return path.join(dshHome(), 'pure-mode', 'prompts', `${sessionId}.md`)
}

/** 读文件，读不到返回 undefined。 */
function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 按会话解析提示词：会话级（非空）优先，其次显式文件，再次全局，最后空串。 */
export function resolvePrompt(sessionId, explicitFile) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid) {
    const own = readFile(sessionPromptFile(sid))
    if (typeof own === 'string' && own.trim().length > 0) return own
  }
  if (typeof explicitFile === 'string' && explicitFile.trim().length > 0) {
    const explicit = readFile(explicitFile)
    if (typeof explicit === 'string') return explicit
  }
  const shared = readFile(globalPromptFile())
  return typeof shared === 'string' ? shared : ''
}

/** 工具选择文件：`<DSH_HOME>/pure-mode/tools.json`，内容形如 `{"tools":["read","pwsh"]}`。 */
export function toolSelectionFile() {
  return path.join(dshHome(), 'pure-mode', 'tools.json')
}

/** 可选的工具目录（按分组，仅用于面板展示）。
 *  只保留「操作这台电脑」的最小闭环：读写文件、搜索、执行命令。
 *  多一个工具就多一份 schema、多一份 preset 挂载风险，其余一律不列。
 */
export const TOOL_CATALOG = [
  {
    group: '文件',
    items: [
      { name: 'read', label: '读取文件' },
      { name: 'write', label: '写入文件' },
      { name: 'edit', label: '编辑文件' },
      { name: 'read_image', label: '读取图片' },
    ],
  },
  {
    group: '搜索',
    items: [
      { name: 'glob', label: '按文件名查找' },
      { name: 'grep', label: '按内容搜索' },
    ],
  },
  {
    group: '命令',
    items: [{ name: 'pwsh', label: 'PowerShell' }],
  },
]

/** 读当前勾选的工具名；文件不存在 = 一个都不给。 */
export function readToolSelection() {
  const raw = readFile(toolSelectionFile())
  if (typeof raw !== 'string' || raw.trim().length === 0) return new Set()
  try {
    const data = JSON.parse(raw)
    const list = Array.isArray(data?.tools) ? data.tools : []
    return new Set(list.filter((x) => typeof x === 'string' && x.length > 0))
  } catch {
    return new Set()
  }
}

/** 把装配结果洗成"只有自己的段 + 空上下文 + 按选择过滤的工具"。 */
export function cleanAssembly(out, exclusive, allowedTools) {
  if (!out || typeof out !== 'object') return out
  if (Array.isArray(out.sections) && exclusive) {
    out.sections = out.sections.filter((s) => s?.name === SECTION)
  }
  out.contexts = []
  const allowed = allowedTools instanceof Set ? allowedTools : new Set()
  out.tools = Array.isArray(out.tools) ? out.tools.filter((tool) => allowed.has(tool?.name)) : []
  return out
}

/**
 * 会话是否是纯净模式：首选 agentPresets.composedPreset，退化到 session header。
 */
function detectPreset(ctx, agent) {
  try {
    const registry = ctx.get?.('agentPresets')
    const id = registry?.composedPreset?.(agent.ctx)
    if (typeof id === 'string') return id
  } catch {
    /* 服务不可用就走退化路径 */
  }
  try {
    const fromHeader = agent?.session?.header?.agentPreset
    if (typeof fromHeader === 'string') return fromHeader
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * 在 agent 的 systemPrompt.assemble 外面再包一层。
 * 包完占住 dsh-purge 的槽，它从此只更新 slot.rewrite、不再重包我们。
 */
export function installAssembleGuard(prompt, isPureSession, log) {
  if (!prompt || typeof prompt.assemble !== 'function') return false
  if (prompt[PURE_SLOT]) return true

  const orig = prompt.assemble
  const ours = async function assembleWithPureMode(...args) {
    const out = await orig.apply(prompt, args)
    if (!out || typeof out !== 'object') return out
    const context = args[0]
    const sid = context?.agent?.session?.id
    if (!isPureSession(sid)) return out
    const before = {
      sections: Array.isArray(out.sections) ? out.sections.length : 0,
      contexts: Array.isArray(out.contexts) ? out.contexts.length : 0,
      tools: Array.isArray(out.tools) ? out.tools.length : 0,
    }
    const cleaned = cleanAssembly(out, true, readToolSelection())
    try {
      log?.(cleaned, context, before)
    } catch {
      /* 日志失败不影响装配 */
    }
    return cleaned
  }

  const slot = { rewrite: () => {} }
  const getter = function assembleGuard() {
    return ours
  }
  getter[PURGE_SLOT] = slot
  getter[PURE_SLOT] = { installed: true, orig }

  try {
    Object.defineProperty(prompt, 'assemble', {
      configurable: true,
      enumerable: true,
      get: getter,
      set() {
        /* 拒收外部 set（含 purge 的 wrap），保住我们的最外层 */
      },
    })
    return true
  } catch {
    return false
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ promptFile?: string, exclusive?: boolean, debug?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  // host 条目：只装路由，让 client-modules 扫描到本包的 dsh.client。
  // preset 条目：走下面的 agent 平面逻辑。
  if (config?.mode === 'host') {
    let routes = null
    const mountRoutes = (host) => {
      try {
        routes = installRoutes(host)
      } catch (error) {
        routes = `error: ${String((error && error.message) || error)}`
      }
    }
    try {
      ctx.inject?.(['webServer', 'connection'], (injected) => mountRoutes(injected))
    } catch {
      mountRoutes(ctx)
    }

    // 诊断：boot 之后问 clientModules「client 表里有没有本包」，
    // 再问 agentPresets「pure 这个 preset 到底有没有挂上、失败原因是什么」。
    // 结果写 <DSH_HOME>/pure-mode/client-boot.log。
    try {
      const timer = setTimeout(async () => {
        try {
          const mods = ctx.get?.('clientModules')
          const graph = mods?.graph?.()
          const entries = graph?.entries
          const ids = Array.isArray(entries)
            ? entries.map((row) => row?.id).filter(Boolean)
            : entries && typeof entries === 'object'
              ? Object.keys(entries)
              : []
          const clientPath = mods?.clientPath?.('dsh-pure-mode')

          let presets = null
          try {
            const registry = ctx.get?.('agentPresets')
            const list = await registry?.list?.()
            presets = Array.isArray(list)
              ? list.map((item) => ({
                  id: item?.id ?? null,
                  name: item?.name ?? null,
                  broken: item?.broken === undefined ? null : String(item.broken).slice(0, 600),
                }))
              : null
          } catch (error) {
            presets = [{ error: String(error?.message || error) }]
          }

          const dir = path.join(dshHome(), 'pure-mode')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(
            path.join(dir, 'client-boot.log'),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                hasService: Boolean(mods),
                hasGraph: Boolean(graph),
                clientPath: clientPath ?? null,
                pureInGraph: ids.includes('dsh-pure-mode'),
                routes,
                presets,
                ids,
              },
              null,
              2,
            ),
            'utf8',
          )
        } catch {
          /* 诊断失败不影响启动 */
        }
      }, 1500)
      if (typeof timer.unref === 'function') timer.unref()
    } catch {
      /* ignore */
    }
    return
  }

  const explicitFile =
    typeof config?.promptFile === 'string' && config.promptFile.trim().length > 0
      ? config.promptFile.trim()
      : ''
  const exclusive = config?.exclusive !== false
  const debug = config?.debug !== false
  const logFile = path.join(dshHome(), 'pure-mode.log')

  // 共享的"纯净会话"登记表（第三方可读；本插件的判断也走它）
  const pureSessions = (globalThis.__dshPureModeSessions ??= new Set())
  const isPureSession = (sid) => typeof sid === 'string' && pureSessions.has(sid)

  let lastDigest = ''

  const writeLog = (text) => {
    if (!debug) return
    try {
      fs.writeFileSync(logFile, `${text}\n`, 'utf8')
    } catch {
      /* 日志失败不影响装配 */
    }
  }

  const logAssembly = (out, context, before) => {
    const kept = Array.isArray(out.sections) ? out.sections : []
    const tools = Array.isArray(out.tools) ? out.tools : []
    const digest = JSON.stringify([
      context?.agent?.session?.id ?? '',
      kept.map((s) => String(s?.text ?? '').length),
      tools.map((t) => t?.name),
    ])
    if (digest === lastDigest) return
    lastDigest = digest
    const contaminated = kept.length !== 1 || kept[0]?.name !== SECTION
    writeLog(
      [
        `[pure-mode] ${new Date().toISOString()}`,
        `session   : ${context?.agent?.session?.id ?? '-'}`,
        `prompt    : ${String(kept[0]?.text ?? '').length} bytes`,
        `before    : sections=${before?.sections ?? '?'} contexts=${before?.contexts ?? '?'} tools=${before?.tools ?? '?'}`,
        `after     : sections=${JSON.stringify(kept.map((s) => s?.name))} contexts=0 tools=${JSON.stringify(tools.map((t) => t?.name))}`,
        contaminated ? 'WARN      : 装配里残留了非纯净段，已强制过滤' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  // ① 唯一提示词段。text 收 context，按会话取文件。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION,
        order: 0,
        interpolate: false,
        ...(exclusive ? { complete: true } : {}),
        text: (context) => resolvePrompt(context?.agent?.session?.id, explicitFile),
      }),
    'pure-mode.section()',
  )

  // ② 可选运行时上下文全部不评估。
  ctx.effect(
    () => ctx.systemPrompt.suppressRuntimeContext(),
    'pure-mode.suppressRuntimeContext()',
  )

  // ③ 让 refreshContext 不再补回 required 的 cwd：同名 scoped context 覆盖。
  try {
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: 'working-directory:current',
          order: 0,
          interpolate: false,
          text: '',
        }),
      'pure-mode.shadow-working-directory',
    )
  } catch {
    /* 同名注册被拒时跳过；④ 仍然生效 */
  }

  // ④ waterfall 最外层清洗（里层保险）。
  ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      // 只有 pure preset 的 agent 才登记/清洗，绝不碰标准模式。
      const isPure = context?.agent ? detectPreset(ctx, context.agent) === 'pure' : false
      const sid = context?.agent?.session?.id
      if (isPure && typeof sid === 'string' && sid.length > 0) pureSessions.add(sid)
      const out = await next()
      if (!isPure) return out
      const before = {
        sections: Array.isArray(out?.sections) ? out.sections.length : 0,
        contexts: Array.isArray(out?.contexts) ? out.contexts.length : 0,
        tools: Array.isArray(out?.tools) ? out.tools.length : 0,
      }
      const cleaned = cleanAssembly(out, exclusive, readToolSelection())
      try {
        logAssembly(cleaned, context, before)
      } catch {
        /* ignore */
      }
      return cleaned
    },
    { prepend: true },
  )

  // ⑤ 方法级包装：跑在 dsh-purge 的 assemble guard 外面。
  // 注意：宿主每次取 loopCtx.systemPrompt 可能拿到不同的 shadow 对象，一次性
  // 包装会漏。所以除了 agent/created 装一次，还有一个 250ms 的守护轮询：
  // 对每个纯净 agent 的**当前**对象确保包装，并占住 purge 的槽让它不再重包。
  const ensurePureGuard = (agent) => {
    try {
      const prompt = agent?.loopCtx?.systemPrompt
      if (!prompt) return false
      return installAssembleGuard(prompt, isPureSession, logAssembly)
    } catch {
      return false
    }
  }

  ctx.on(
    'agent/created',
    ({ agent }) => {
      try {
        const preset = detectPreset(ctx, agent)
        if (preset !== 'pure') return
        const sid = agent?.session?.id
        if (typeof sid === 'string') pureSessions.add(sid)
        const ok = ensurePureGuard(agent)
        writeLog(
          [
            `[pure-mode] ${new Date().toISOString()}`,
            `agent     : ${agent?.id ?? '-'} session=${sid ?? '-'} preset=${preset}`,
            `guard     : ${ok ? 'installed' : 'skipped'}`,
          ].join('\n'),
        )
      } catch (error) {
        writeLog(`[pure-mode] agent/created failed: ${String(error?.message || error)}`)
      }
    },
    { global: true },
  )

  // 持续守护已移除：轮询既费资源也不保证命中。真正的确定性在注入方
  // （dsh-purge 的 rewriteLiveAssembly 读 __dshPureModeSessions 让路），
  // 这里只保留 agent/created 的一次性包装作为二道保险。

  // ⑥ HTTP 路由：给左上角面板读写提示词。
  let routeOk = false
  try {
    routeOk = installRoutes(ctx)
  } catch (error) {
    writeLog(`[pure-mode] routes failed: ${String(error?.message || error)}`)
  }

  writeLog(`[pure-mode] mounted file=${explicitFile || globalPromptFile()} exclusive=${exclusive} routes=${routeOk}`)
}

/** 会话 id 只允许安全字符，绝不用它拼出上级路径。 */
function safeSessionId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text) ? text : undefined
}

/** zstd 多帧解压：会话日志是一帧一事件的追加流。 */
function unzstdFrames(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      offsets.push(i)
      i += 3
    }
  }
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = offsets[k + 1] ?? buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      /* 单帧坏了就跳过 */
    }
  }
  return Buffer.concat(parts)
}

/** 三个版本的日志文件名，按新到旧尝试。 */
const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']

/** 在 $DSH_HOME/sessions/<workspace>/<sessionId>/ 里找日志文件。 */
function findSessionLog(sessionId) {
  const root = path.join(dshHome(), 'sessions')
  let spaces = []
  try {
    spaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return undefined
  }
  for (const ws of spaces) {
    for (const name of SESSION_LOG_NAMES) {
      const file = path.join(root, ws.name, sessionId, name)
      try {
        if (fs.statSync(file).isFile()) return file
      } catch {
        /* 试下一个 */
      }
    }
  }
  return undefined
}

/** 会话日志解析缓存：key = 文件: mtime。 */
const sessionSystemCache = new Map()

/** 从一个会话日志里取出 preset 与最后一条 system/message。 */
function readSessionSystem(sessionId) {
  const file = findSessionLog(sessionId)
  if (file === undefined) return { error: 'no-session-log' }
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { error: 'no-session-log' }
  }
  const key = `${file}:${stat.mtimeMs}`
  const cached = sessionSystemCache.get(key)
  if (cached !== undefined) return cached

  let text = ''
  try {
    text = unzstdFrames(fs.readFileSync(file)).toString('utf8')
  } catch (error) {
    return { error: `unpack-failed: ${String(error?.message || error)}` }
  }

  let preset
  let system
  let title
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'session' && typeof event.agentPreset === 'string') preset = event.agentPreset
    if (event?.type === 'agent-preset/selected' && typeof event?.data?.agentPreset === 'string') {
      preset = event.data.agentPreset
    }
    if (event?.type === 'session/title' && typeof event?.data?.title === 'string') title = event.data.title
    if (event?.type === 'system/message') {
      const content = event?.data?.message?.content
      system = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : ''
    }
  }

  const result = {
    preset: preset ?? null,
    title: title ?? '',
    system: system ?? '',
    bytes: Buffer.byteLength(system ?? '', 'utf8'),
    log: file,
  }
  sessionSystemCache.set(key, result)
  if (sessionSystemCache.size > 64) {
    const oldest = sessionSystemCache.keys().next().value
    sessionSystemCache.delete(oldest)
  }
  return result
}

/** 读写提示词的 JSON 路由（GET 读、PUT 写、DELETE 删掉会话覆盖）。 */
export function installRoutes(ctx) {
  const webServer = ctx?.webServer ?? ctx?.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') return false
  const connection = ctx?.connection ?? ctx?.get?.('connection')

  const sendJson = (res, status, data) => {
    const body = JSON.stringify(data)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const rejected = (req, res) => {
    try {
      const verdict = connection?.requestRejection?.(req)
      if (verdict !== undefined && verdict !== null && verdict !== false) {
        res.writeHead(verdict)
        res.end()
        return true
      }
    } catch {
      res.writeHead(503)
      res.end()
      return true
    }
    return false
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 256 * 1024) {
          req.destroy()
          resolve('')
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

  const handler = async (req, res) => {
    if (rejected(req, res)) return

    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { error: 'bad-url' })
      return
    }
    const pathname = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    // ── 提示词读写 ────────────────────────────────────────────────
    if (pathname === '/pure-mode/prompt') {
      const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'global'
      const sessionId = scope === 'session' ? safeSessionId(url.searchParams.get('sessionId')) : undefined
      if (scope === 'session' && sessionId === undefined) {
        sendJson(res, 400, { error: 'bad-session-id' })
        return
      }

      const file = scope === 'session' ? sessionPromptFile(sessionId) : globalPromptFile()
      const fallback = scope === 'session' ? (readFile(globalPromptFile()) ?? '') : ''

      if (method === 'GET') {
        const own = readFile(file)
        const hasOverride = typeof own === 'string' && own.trim().length > 0
        const shared = globalPromptFile()
        // 标出「这次读到的内容到底来自哪个文件」。
        const source = hasOverride ? 'session' : scope === 'session' ? 'global (inherited)' : 'global'
        const sourcePath = hasOverride ? file : shared
        sendJson(res, 200, {
          scope,
          sessionId: sessionId ?? null,
          path: file,
          source,
          sourcePath,
          text: typeof own === 'string' ? own : '',
          hasOverride,
          fallback,
        })
        return
      }

      if (method === 'DELETE') {
        try {
          fs.rmSync(file, { force: true })
        } catch (error) {
          sendJson(res, 500, { error: String(error?.message || error) })
          return
        }
        sendJson(res, 200, { ok: true, scope, sessionId: sessionId ?? null })
        return
      }

      if (method === 'PUT') {
        const raw = await readBody(req)
        let body = null
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          sendJson(res, 400, { error: 'bad-json' })
          return
        }
        const text = typeof body?.text === 'string' ? body.text : ''
        if (Buffer.byteLength(text, 'utf8') > 200 * 1024) {
          sendJson(res, 413, { error: 'too-large' })
          return
        }
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, text, 'utf8')
        } catch (error) {
          sendJson(res, 500, { error: String(error?.message || error) })
          return
        }
        sendJson(res, 200, {
          ok: true,
          scope,
          sessionId: sessionId ?? null,
          bytes: Buffer.byteLength(text, 'utf8'),
        })
        return
      }

      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }

    // ── 工具选择 ─────────────────────────────────────────────────
    if (pathname === '/pure-mode/tools') {
      const valid = new Set(TOOL_CATALOG.flatMap((group) => group.items.map((item) => item.name)))
      if (method === 'GET') {
        sendJson(res, 200, {
          catalog: TOOL_CATALOG,
          selected: [...readToolSelection()].filter((name) => valid.has(name)),
        })
        return
      }
      if (method === 'PUT') {
        const raw = await readBody(req)
        let body = null
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          sendJson(res, 400, { error: 'bad-json' })
          return
        }
        const list = Array.isArray(body?.tools) ? body.tools : []
        const tools = [...new Set(list.filter((name) => typeof name === 'string' && valid.has(name)))]
        try {
          fs.mkdirSync(path.dirname(toolSelectionFile()), { recursive: true })
          fs.writeFileSync(toolSelectionFile(), `${JSON.stringify({ tools }, null, 2)}\n`, 'utf8')
        } catch (error) {
          sendJson(res, 500, { error: String(error?.message || error) })
          return
        }
        sendJson(res, 200, { ok: true, tools })
        return
      }
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }

    // ── 会话列表 ──────────────────────────────────────────────────
    if (pathname === '/pure-mode/sessions') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }

      const known = new Map()

      // 1) 会话日志目录：最全的来源（含已归档、已不在最近列表里的会话）
      try {
        const root = path.join(dshHome(), 'sessions')
        for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
          if (!ws.isDirectory()) continue
          let entries = []
          try {
            entries = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
            known.set(entry.name, { id: entry.name, title: '', cwd: '' })
          }
        }
      } catch {
        /* 没有 sessions 目录 */
      }

      // 2) workspace.json：补工作目录
      try {
        const raw = fs.readFileSync(path.join(dshHome(), 'storages', 'workspace.json'), 'utf8')
        const data = JSON.parse(raw)
        for (const row of Object.values(data?.tables?.workspaces ?? {})) {
          const cwd = typeof row?.path === 'string' ? row.path : ''
          for (const id of row?.sessionIds ?? []) {
            const cur = known.get(id) ?? { id, title: '', cwd: '' }
            if (!cur.cwd && cwd) cur.cwd = cwd
            known.set(id, cur)
          }
        }
      } catch {
        /* 没有 workspace 投影 */
      }

      // 3) projcache：补标题
      try {
        const raw = fs.readFileSync(path.join(dshHome(), 'storages', 'session_projcache.json'), 'utf8')
        const cache = JSON.parse(raw)
        for (const [id, row] of Object.entries(cache?.tables?.sessions ?? {})) {
          const cur = known.get(id) ?? { id, title: '', cwd: '' }
          const title = row?.rows?.title?.val
          if (typeof title === 'string' && title) cur.title = title
          const cwd = row?.identity?.cwd
          if (typeof cwd === 'string' && cwd && !cur.cwd) cur.cwd = cwd
          known.set(id, cur)
        }
      } catch {
        /* 没有投影缓存 */
      }

      const list = []
      for (const item of known.values()) {
        const own = readFile(sessionPromptFile(item.id))
        const meta = readSessionSystem(item.id)
        const title = (typeof meta?.title === 'string' && meta.title) || item.title || ''
        const bytes = typeof meta?.bytes === 'number' ? meta.bytes : 0
        list.push({
          id: item.id,
          title,
          cwd: item.cwd,
          preset: meta?.preset ?? null,
          sysBytes: bytes,
          empty: bytes === 0,
          hasOverride: typeof own === 'string' && own.trim().length > 0,
        })
      }
      list.sort((a, b) => {
        if (!a.title && b.title) return 1
        if (a.title && !b.title) return -1
        return (a.title || a.id).localeCompare(b.title || b.id)
      })
      sendJson(res, 200, { sessions: list })
      return
    }

    // ── 只读：任意会话实际收到的 system ────────────────────────────
    if (pathname === '/pure-mode/system') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const sessionId = safeSessionId(url.searchParams.get('sessionId'))
      if (sessionId === undefined) {
        sendJson(res, 400, { error: 'bad-session-id' })
        return
      }
      const result = readSessionSystem(sessionId)
      sendJson(res, 200, { sessionId, ...result })
      return
    }

    // ── client 半诊断上报 ─────────────────────────────────────────
    if (pathname === '/pure-mode/client-log') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const raw = await readBody(req)
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = null
      }
      try {
        const dir = path.join(dshHome(), 'pure-mode')
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'client.log'), `${new Date().toISOString()} ${JSON.stringify(body)}\n`, 'utf8')
      } catch {
        /* 写不进去就算了 */
      }
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not-found', path: pathname })
  }

  try {
    return typeof webServer.register({ kind: 'prefix', path: '/pure-mode', handler }) === 'function'
  } catch {
    return false
  }
}
