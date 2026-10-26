// 对比「官方 standard preset 的工具行」与「纯净模式的工具行」，输出差异。
//
// 用法：
//   node tools-sync.mjs
//   node tools-sync.mjs "D:/Program Files/.../dsh-web-app/presets/standard.patch.yml"
//
// 触发时机：DSH 升级之后、出现 "entry did not activate"、纯净模式从模式列表消失、
// 或工具行为与标准模式不一致时。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STANDARD =
  'D:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const OURS = path.join(process.cwd(), 'cordis.patch.yml')

const standardPath = process.argv[2] || DEFAULT_STANDARD

/**
 * 从一段 loader YAML 里抽出「插件行」：{ id, name, indent, configKeys }。
 * configKeys 只取 config 下一层的键名，用来发现官方新增的必填字段。
 */
function parseRows(file) {
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

  const rows = []
  let current = null
  let configIndent = -1

  for (const raw of lines) {
    if (raw.trim().length === 0 || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const trimmed = raw.trim()

    const idMatch = /^-\s*id:\s*(.+)$/.exec(trimmed)
    if (idMatch) {
      current = {
        id: idMatch[1].trim().replace(/^['"]|['"]$/g, ''),
        name: '',
        indent,
        configKeys: [],
      }
      rows.push(current)
      configIndent = -1
      continue
    }
    if (current === null) continue
    if (indent <= current.indent) continue // 离开该行

    const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
    if (nameMatch && current.name === '') {
      current.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    if (/^config:\s*$/.test(trimmed)) {
      configIndent = indent
      continue
    }
    if (configIndent >= 0 && indent === configIndent + 2) {
      const keyMatch = /^([A-Za-z0-9_]+):/.exec(trimmed)
      if (keyMatch) current.configKeys.push(keyMatch[1])
    }
  }
  return rows
}

const standard = parseRows(standardPath)
if (standard === null) {
  console.error(`找不到官方 standard preset：${standardPath}`)
  process.exit(1)
}
const ours = parseRows(OURS)
if (ours === null) {
  console.error(`找不到本插件的 patch：${OURS}`)
  process.exit(1)
}

const isOfficialTool = (row) => /^@deepseek-ai\/dsh-tool-/.test(row.name)
const isOurTool = (row) => /^@deepseek-ai\/dsh-tool-/.test(row.name)

const byName = (rows) => {
  const map = new Map()
  for (const row of rows) if (!map.has(row.name)) map.set(row.name, row)
  return map
}

const standardTools = byName(standard.filter(isOfficialTool))
const ourTools = byName(ours.filter(isOurTool))

const missing = [...standardTools.keys()].filter((name) => !ourTools.has(name))
const extra = [...ourTools.keys()].filter((name) => !standardTools.has(name))

// 官方有、我们没有的配置键 —— 这类缺失会让插件 invalid config，整个 preset broken
const configGaps = []
for (const [name, standardRow] of standardTools) {
  const ourRow = ourTools.get(name)
  if (ourRow === undefined) continue
  const have = new Set(ourRow.configKeys)
  const want = standardRow.configKeys.filter((key) => !have.has(key))
  if (want.length > 0) configGaps.push({ name, want })
}

console.log('官方 standard 的工具行：', standardTools.size)
console.log('纯净模式的工具行    ：', ourTools.size)
console.log('')

let problems = 0

if (missing.length > 0) {
  problems += 1
  console.log('⚠️  官方有、纯净模式没有的工具（想要就加，不想要可忽略）：')
  for (const name of missing) console.log('   -', name)
  console.log('')
}

if (configGaps.length > 0) {
  problems += 1
  console.log('❌ 配置缺失（会让 preset 变 broken，必须补）：')
  for (const gap of configGaps) console.log(`   - ${gap.name} 缺 config 键：${gap.want.join(', ')}`)
  console.log('')
}

if (extra.length > 0) {
  console.log('ℹ️  纯净模式有、官方没有的工具（可能是旧名或有意保留）：')
  for (const name of extra) console.log('   +', name)
  console.log('')
}

if (problems === 0) {
  console.log('✅ 工具清单与必填配置和官方一致。')
} else {
  console.log('修法：把缺的 config 键按官方写法补进 cordis.patch.yml 对应工具行；')
  console.log('      缺的工具行按需添加（带服务的重插件可以不加）。')
}
