/**
 * dsh-pure-mode 的 agent 半入口。
 *
 * 存在的唯一理由：preset 子插件必须用一个 **带子路径** 的说明符
 * （exactPackageSpecifier 对含 "/" 的名字返回 undefined），
 * 才不会和 host 条目 `dsh-pure-mode` 在 client-modules 里形成
 * "package resolves from multiple active Loader sources" 冲突。
 *
 * 实现完全复用 index.js，只是换个名字挂载。
 */

export { apply, inject } from './index.js'

/** 与 host 条目区分开的名字，避免诊断里两者同名。 */
export const name = 'pure-mode-agent'
