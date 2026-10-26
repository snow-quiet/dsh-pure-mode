# dsh-pure-mode

DSH 的**纯净模式**：一个 agent preset，只装配你自己的提示词；并提供一个左上角面板管理全局 / 会话提示词。

## 装配结果

- 没有 harness 身份段
- 没有工具指引、没有工具 schema（模型拿不到任何工具）
- 没有运行时上下文（时间 / cwd / sandbox 策略 / 技能目录 / AGENTS.md 全无）
- 没有官方 agent 平面的任何插件

## 三层防线（从里到外）

| 层 | 做法 | 作用 |
|---|---|---|
| ① section | `systemPrompt.section({ complete: true })` | 官方 assemble 保证这是唯一段 |
| ② waterfall | `system-prompt/assemble` + `prepend` | 压掉第三方注册的段/上下文/工具 |
| ③ 方法级 | 包 `agent.loopCtx.systemPrompt.assemble` | 跑在 dsh-purge 的 assemble guard **外面**，并占住它的 `Symbol.for("dsh-purge.assembleGuard")` 槽让它不再重包 |

第 ③ 层是必须的：dsh-purge 在内层 `rewriteLiveAssembly` 里每轮把 inject 塞回去，只靠 ①② 会被它覆盖。

## 提示词

优先级：**会话覆盖 > 全局 > 空**

| 作用域 | 文件 |
|---|---|
| 全局 | `%USERPROFILE%\.dsh\pure-prompt.md` |
| 会话 | `%USERPROFILE%\.dsh\pure-mode\prompts\<sessionId>.md` |
| 空 | 文件不存在或内容为空 → 模型收到空的 system |

每轮装配重读文件，改完下一轮生效，不需要重启。

## 左上角面板

`conversation.header.leading` 槽（会话标题左侧）注册「提示词」按钮，打开右侧抽屉：

- **全局提示词**：编辑 `pure-prompt.md`
- **会话提示词**：下拉选会话，编辑该会话的覆盖；「删除覆盖」回落全局
- 底部显示当前字符数、是否处于覆盖状态

数据走 host 路由：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/pure-mode/prompt?scope=global` | GET / PUT | 读/写全局 |
| `/pure-mode/prompt?scope=session&sessionId=…` | GET / PUT / DELETE | 读/写/删会话覆盖 |
| `/pure-mode/sessions` | GET | 会话列表（标题、cwd、是否有覆盖） |

所有请求先过 `connection.requestRejection`；会话 id 只允许 `[A-Za-z0-9._-]`，不拼路径。

## 文件

```
dsh-pure-mode/
├─ package.json        # dsh.bundle.patch + dsh.client
├─ cordis.patch.yml    # 只 insert 一条 preset（id: pure）
├─ index.js            # host 半：section / 清洗 / guard / 路由
├─ client.js           # client 半：左上角入口 + 面板
├─ selftest.mjs        # 离线测试
└─ README.md
```

## 启用 / 回滚

启用：profile 的 `package.json` 里 `dependencies` 加 file: 依赖、`dsh.profile.bundles` 加 `dsh-pure-mode`，`pnpm install`，重启。

回滚：删掉这两处，`pnpm install`，重启。插件不写 profile 之外的配置。

### 从 GitHub 安装

```powershell
git clone https://github.com/snow-quiet/dsh-pure-mode "$env:USERPROFILE\.dsh\plugins\dsh-pure-mode"
```

然后按下面「从 zip 安装」的第 2–4 步配置 profile 并 `pnpm install`。

### 从 zip 安装

1. 解压，得到 `dsh-pure-mode/` 目录，放到任意位置，例如
   `C:\Users\<你>\.dsh\plugins\dsh-pure-mode`
2. 打开 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`：
   - `dependencies` 加一行 `"dsh-pure-mode": "file:<解压后的绝对路径，用 / 分隔>"`
   - `dsh.profile.bundles` 数组里加 `"dsh-pure-mode"`
3. 在该 profile 目录执行 `pnpm install`
4. 重启 DSH 桌面端

示例：

```json
{
  "dependencies": {
    "dsh-pure-mode": "file:C:/Users/me/.dsh/plugins/dsh-pure-mode"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-pure-mode"]
    }
  }
}
```

卸载：删掉这两处 → `pnpm install` → 重启。

## 升级后检查

```powershell
cd <插件目录>; node tools-sync.mjs
```

- 输出「配置缺失」→ 必须补（否则 preset 变 broken、模式从列表消失）
- 输出「官方有、我们没有的工具」→ 按需，重插件可以不加

## 验证

```powershell
cd C:\Users\33631\.dsh; node pure-check.mjs
```

期望：

```
preset  : pure
--- system/message turn 1 step 1: 28 chars ---
tools in request header: 0
runtime-context user messages: 0
```

诊断日志：`%USERPROFILE%\.dsh\pure-mode.log`（`guard: installed` 表示第 ③ 层已装上）。
