// 离线装配测试：不启动 DSH，用假 ctx 验证 dsh-pure-mode 的注册、清洗与方法级 guard。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply,
  cleanAssembly,
  globalPromptFile,
  installAssembleGuard,
  resolvePrompt,
  sessionPromptFile,
} from './index.js'

const calls = { sections: [], contexts: [], suppress: 0, listeners: [] }

function makeCtx(presetId) {
  return {
    effect(setup) {
      const d = setup()
      return () => {
        if (typeof d === 'function') d()
      }
    },
    on(event, handler, options) {
      calls.listeners.push({ event, handler, options })
      return () => {}
    },
    get(name) {
      if (name === 'agentPresets') {
        return { composedPreset: (agentCtx) => agentCtx?.__preset ?? presetId }
      }
      return undefined
    },
    systemPrompt: {
      section(section) {
        calls.sections.push(section)
        return () => {}
      },
      context(context) {
        calls.contexts.push(context)
        return () => {}
      },
      suppressRuntimeContext() {
        calls.suppress += 1
        return () => {}
      },
    },
  }
}

// ── 0. 准备临时提示词文件 ────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-mode-test-'))
process.env.DSH_HOME = home
fs.writeFileSync(globalPromptFile(), 'GLOBAL PROMPT\n', 'utf8')
fs.mkdirSync(path.dirname(sessionPromptFile('session-a')), { recursive: true })
fs.writeFileSync(sessionPromptFile('session-a'), 'SESSION PROMPT\n', 'utf8')

assert.equal(resolvePrompt('session-a'), 'SESSION PROMPT\n', '会话级优先')
assert.equal(resolvePrompt('session-b'), 'GLOBAL PROMPT\n', '回落到全局')
assert.equal(resolvePrompt(undefined, undefined), 'GLOBAL PROMPT\n', '无会话也读全局')

// ── 1. 段与上下文注册 ──────────────────────────────────────────────────
apply(makeCtx('pure'), { exclusive: true, debug: false })

assert.equal(calls.sections.length, 1, '只注册一个段')
const [sec] = calls.sections
assert.equal(sec.name, 'pure:prompt')
assert.equal(sec.order, 0)
assert.equal(sec.interpolate, false)
assert.equal(sec.complete, true, 'complete 必须为 true')
assert.equal(typeof sec.text, 'function')
assert.equal(sec.text({ agent: { session: { id: 'session-a' } } }), 'SESSION PROMPT\n')

assert.equal(calls.suppress, 1)
assert.equal(calls.contexts[0].name, 'working-directory:current')
assert.equal(calls.contexts[0].required, undefined, '影子 context 不能是 required')

// ── 2. waterfall 清洗只对纯净会话 ──────────────────────────────────────
const waterfall = calls.listeners.find((l) => l.event === 'system-prompt/assemble')
assert.ok(waterfall, '注册了 assemble 监听')
assert.equal(waterfall.options?.prepend, true)

const dirty = () => ({
  sections: [
    { name: 'dsh-purge', text: 'x' },
    { name: 'pure:prompt', text: 'p' },
  ],
  contexts: [{ name: 'working-directory:current' }],
  tools: [{ name: 'bash' }],
})

const untouched = await waterfall.handler(
  {},
  { agent: { ctx: { __preset: 'standard' }, session: { id: 'session-other' } } },
  async () => dirty(),
)
assert.equal(untouched.contexts.length, 1, '非纯净会话不清洗')

await waterfall.handler(
  {},
  { agent: { ctx: { __preset: 'pure' }, session: { id: 'session-pure' } } },
  async () => dirty(),
)
const cleaned = await waterfall.handler(
  {},
  { agent: { ctx: { __preset: 'pure' }, session: { id: 'session-pure' } } },
  async () => dirty(),
)
assert.deepEqual(cleaned.sections.map((s) => s.name), ['pure:prompt'])
assert.deepEqual(cleaned.contexts, [])
assert.deepEqual(cleaned.tools, [])

// ── 3. 方法级 guard（跑在 dsh-purge 外面）──────────────────────────────
const prompt = {
  assemble: async () => ({
    sections: [
      { name: 'dsh-purge', text: 'locked' },
      { name: 'pure:prompt', text: 'p' },
    ],
    contexts: [{ name: 'cwd' }],
    tools: [{ name: 'bash' }],
  }),
}

const pure = new Set(['session-pure'])
assert.equal(
  installAssembleGuard(
    prompt,
    (sid) => pure.has(sid),
    () => {},
  ),
  true,
)
assert.equal(
  installAssembleGuard(
    prompt,
    (sid) => pure.has(sid),
    () => {},
  ),
  true,
  '重复安装幂等',
)

const PURGE_SLOT = Symbol.for('dsh-purge.assembleGuard')
const desc = Object.getOwnPropertyDescriptor(prompt, 'assemble')
assert.ok(desc?.get, 'assemble 变成 accessor')
assert.ok(desc.get[PURGE_SLOT], '占住 purge 的停火槽')

const out = await prompt.assemble({ agent: { session: { id: 'session-pure' } } })
assert.deepEqual(
  out.sections.map((s) => s.name),
  ['pure:prompt'],
  'guard 外层清洗生效',
)
assert.deepEqual(out.tools, [])

const other = await prompt.assemble({ agent: { session: { id: 'session-other' } } })
assert.deepEqual(
  other.sections.map((s) => s.name),
  ['dsh-purge', 'pure:prompt'],
  '非纯净会话不动',
)

// 模拟 purge 的 installAssembleGuard：命中槽后只更新 rewrite，不再重包
desc.get[PURGE_SLOT].rewrite = () => 'REWRITTEN'
const after = await prompt.assemble({ agent: { session: { id: 'session-pure' } } })
assert.deepEqual(
  after.sections.map((s) => s.name),
  ['pure:prompt'],
  'purge 的 rewrite 不影响最终结果',
)

// ── 4. agent/created 会装 guard ───────────────────────────────────────
calls.listeners.length = 0
apply(makeCtx('pure'), { exclusive: true, debug: false })
const created = calls.listeners.find((l) => l.event === 'agent/created')
assert.ok(created, '注册了 agent/created')
assert.equal(created.options?.global, true, '必须 global，否则 scoped 过滤收不到')

const loopPrompt = {
  assemble: async () => ({ sections: [{ name: 'x', text: '1' }], contexts: [], tools: [] }),
}
created.handler({
  agent: {
    id: 'agent-1',
    ctx: {},
    session: { id: 'session-created' },
    loopCtx: { systemPrompt: loopPrompt },
  },
})
const createdDesc = Object.getOwnPropertyDescriptor(loopPrompt, 'assemble')
assert.ok(createdDesc?.get?.[PURGE_SLOT], 'agent 的 systemPrompt 被包住')

// ── 5. 非 pure preset 不碰 ─────────────────────────────────────────────
calls.listeners.length = 0
apply(makeCtx('standard'), { exclusive: true, debug: false })
const createdStd = calls.listeners.find((l) => l.event === 'agent/created')
const stdPrompt = { assemble: async () => ({ sections: [], contexts: [], tools: [] }) }
createdStd.handler({
  agent: {
    id: 'agent-2',
    ctx: {},
    session: { id: 'session-std' },
    loopCtx: { systemPrompt: stdPrompt },
  },
})
const stdDesc = Object.getOwnPropertyDescriptor(stdPrompt, 'assemble')
assert.equal(stdDesc?.get, undefined, '标准模式不被包装成 accessor')

// ── 6. cleanAssembly 幂等 ──────────────────────────────────────────────
assert.deepEqual(
  cleanAssembly({ sections: [{ name: 'pure:prompt', text: 'x' }], contexts: [], tools: [] }, true),
  { sections: [{ name: 'pure:prompt', text: 'x' }], contexts: [], tools: [] },
)

fs.rmSync(home, { recursive: true, force: true })
console.log('ALL PASS')
