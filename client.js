window.__ModuleLoader__.load({
  id: 'dsh-pure-mode',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const ReactNS = require('react')
    const React = ReactNS && ReactNS.createElement ? ReactNS : (ReactNS && ReactNS.default) || ReactNS
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const name = 'dsh-pure-mode'
    const inject = ['slots']
    const API = '/pure-mode'

    /** 诊断上报：把 client 半的执行情况打到 host 的 pure-mode/client.log。 */
    function report(stage, detail) {
      try {
        fetch(`${API}/client-log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: JSON.stringify({ stage, detail: detail ?? null }),
        }).catch(() => {})
      } catch {
        /* ignore */
      }
    }

    report('factory', { loader: typeof window !== 'undefined' && !!window.__ModuleLoader__ })

    async function api(path, init) {
      const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init })
      const raw = await res.text()
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        throw new Error(`${res.status} non-json`)
      }
      if (!res.ok) throw new Error((data && (data.error || data.message)) || `${res.status}`)
      return data
    }

    const page = {
      height: '100%',
      overflow: 'hidden',
      background: 'var(--dsh-color-surface, #fff)',
      color: 'var(--dsh-color-text, #111)',
      boxSizing: 'border-box',
      fontSize: 13,
    }
    const layout = { display: 'flex', height: '100%', minHeight: 0 }
    const side = {
      flex: '0 0 236px',
      width: 236,
      borderRight: '1px solid var(--dsh-color-border, #e5e7eb)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '14px 10px',
      boxSizing: 'border-box',
      overflow: 'auto',
    }
    const sideItem = (active) => ({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
      width: '100%',
      textAlign: 'left',
      border: 'none',
      borderRadius: 8,
      padding: '7px 9px',
      cursor: 'pointer',
      fontSize: 12,
      background: active ? 'rgba(37,99,235,0.12)' : 'transparent',
      color: 'inherit',
    })
    const tag = {
      fontSize: 10,
      opacity: 0.65,
      border: '1px solid currentColor',
      borderRadius: 4,
      padding: '0 4px',
      lineHeight: '14px',
      flex: '0 0 auto',
    }
    const main = {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '18px 20px',
      boxSizing: 'border-box',
      overflow: 'auto',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const btn = {
      border: '1px solid var(--dsh-color-border, #d0d5dd)',
      background: 'var(--dsh-color-surface, #fff)',
      color: 'inherit',
      borderRadius: 8,
      padding: '5px 10px',
      cursor: 'pointer',
      fontSize: 12,
    }
    const btnPrimary = { ...btn, background: '#2563eb', color: '#fff', borderColor: 'transparent' }
    const textarea = {
      flex: 1,
      width: '100%',
      minHeight: 260,
      resize: 'none',
      boxSizing: 'border-box',
      border: '1px solid var(--dsh-color-border, #d0d5dd)',
      borderRadius: 8,
      padding: 10,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.55,
      color: 'inherit',
      background: 'var(--dsh-color-surface, #fff)',
    }
    const readOnly = {
      ...textarea,
      whiteSpace: 'pre-wrap',
      overflow: 'auto',
      background: 'rgba(127,127,127,0.06)',
    }
    const hint = { opacity: 0.65, fontSize: 11, lineHeight: 1.6 }

    /** 把绝对路径缩成 ~\.dsh\... 形式，方便在面板里显示来源。 */
    const shortenPath = (value) => {
      const raw = String(value || '')
      if (!raw) return '—'
      return raw.replace(/^.*?[\\/]\.dsh[\\/]/, '~\\.dsh\\')
    }

    /** 工具选择文件的显示路径。 */
    const toolSelectionFileHint = () => '~\\.dsh\\pure-mode\\tools.json'

    function PromptManager() {
      const [selection, setSelection] = useState('global')
      const [sessions, setSessions] = useState([])
      const [query, setQuery] = useState('')
      const [text, setText] = useState('')
      const [fallback, setFallback] = useState('')
      const [hasOverride, setHasOverride] = useState(false)
      const [sourcePath, setSourcePath] = useState('')
      const [systemView, setSystemView] = useState(null)
      const [toolCatalog, setToolCatalog] = useState([])
      const [toolSelected, setToolSelected] = useState([])
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)

      /** 重新拉会话列表（新建 / 归档的会话靠它出现）。 */
      const loadSessions = useCallback(async () => {
        try {
          const data = await api(`${API}/sessions`)
          setSessions(Array.isArray(data?.sessions) ? data.sessions : [])
          return true
        } catch (error) {
          setStatus(`会话列表读取失败：${String(error.message || error)}`)
          return false
        }
      }, [])

      useEffect(() => {
        loadSessions()
      }, [loadSessions])

      const load = useCallback(async () => {
        setBusy(true)
        try {
          if (selection === 'global') {
            const data = await api(`${API}/prompt?scope=global`)
            const value = typeof data?.text === 'string' ? data.text : ''
            setText(value)
            setFallback('')
            setHasOverride(value.trim().length > 0)
            setSourcePath(typeof data?.path === 'string' ? data.path : '')
            setSystemView(null)
          } else if (selection === 'tools') {
            const data = await api(`${API}/tools`)
            setToolCatalog(Array.isArray(data?.catalog) ? data.catalog : [])
            setToolSelected(Array.isArray(data?.selected) ? data.selected : [])
            setSourcePath(toolSelectionFileHint())
            setSystemView(null)
          } else {
            const sid = encodeURIComponent(selection)
            const [prompt, view] = await Promise.all([
              api(`${API}/prompt?scope=session&sessionId=${sid}`),
              api(`${API}/system?sessionId=${sid}`).catch(() => null),
            ])
            const own = Boolean(prompt?.hasOverride)
            const inherited = typeof prompt?.fallback === 'string' ? prompt.fallback : ''
            // 没有独立覆盖时，直接把继承的全局内容显示出来，避免看起来像空的。
            setText(own ? (typeof prompt?.text === 'string' ? prompt.text : '') : inherited)
            setFallback(inherited)
            setHasOverride(own)
            setSourcePath(
              typeof prompt?.sourcePath === 'string' ? prompt.sourcePath : typeof prompt?.path === 'string' ? prompt.path : '',
            )
            setSystemView(view)
          }
          setStatus('')
        } catch (error) {
          setStatus(`读取失败：${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }, [selection])

      useEffect(() => {
        load()
      }, [load])

      /** 「刷新」= 会话列表 + 当前选中内容一起重读。 */
      const refresh = async () => {
        setBusy(true)
        await loadSessions()
        await load()
        setBusy(false)
        setStatus(`已刷新 ${new Date().toLocaleTimeString()}`)
      }

      const queryString = () =>
        selection === 'global' ? '?scope=global' : `?scope=session&sessionId=${encodeURIComponent(selection)}`

      const save = async () => {
        setBusy(true)
        try {
          if (selection === 'tools') {
            const data = await api(`${API}/tools`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tools: toolSelected }),
            })
            setToolSelected(Array.isArray(data?.tools) ? data.tools : toolSelected)
            setStatus(
              toolSelected.length === 0
                ? '已保存：纯净模式不给任何工具'
                : `已保存：${toolSelected.length} 个工具，下一轮生效`,
            )
            return
          }
          await api(`${API}/prompt${queryString()}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          setHasOverride(text.trim().length > 0)
          setStatus(`已保存（${new Blob([text]).size} 字节），下一轮生效`)
          loadSessions()
        } catch (error) {
          setStatus(`保存失败：${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        if (selection === 'global' || selection === 'tools') return
        setBusy(true)
        try {
          await api(`${API}/prompt${queryString()}`, { method: 'DELETE' })
          setHasOverride(false)
          setText(fallback)
          setStatus('已删除会话覆盖，回落到纯净模式提示词')
          loadSessions()
        } catch (error) {
          setStatus(`清除失败：${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }

      const isTools = selection === 'tools'
      const isSession = selection !== 'global' && !isTools
      const current = sessions.find((s) => s.id === selection)
      const readOnlyView = Boolean(isSession && systemView && systemView.preset && systemView.preset !== 'pure')
      const needle = query.trim().toLowerCase()
      const filtered = needle
        ? sessions.filter(
            (s) => (s.title || '').toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle),
          )
        : sessions

      // 分组：纯净模式会话在前，其他会话在后，中间用分组标题隔开。
      const pureItems = filtered.filter((s) => s.preset === 'pure')
      const otherItems = filtered.filter((s) => s.preset !== 'pure')

      const renderItem = (s) =>
        h(
          'button',
          { key: s.id, style: sideItem(selection === s.id), onClick: () => setSelection(s.id) },
          h(
            'span',
            {
              style: {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
                opacity: s.empty ? 0.55 : 1,
              },
            },
            s.title || s.id.slice(-8),
          ),
          s.hasOverride
            ? h('span', { style: tag }, '★')
            : s.empty
              ? h('span', { style: { ...tag, opacity: 0.4 } }, '空')
              : null,
        )

      const groupTitle = (text, spaced) => ({
        ...hint,
        fontWeight: 600,
        opacity: 0.5,
        padding: spaced ? '10px 4px 2px' : '2px 4px',
        letterSpacing: 0.4,
      })

      return h(
        'div',
        { style: page },
        h(
          'div',
          { style: layout },
          h(
            'aside',
            { style: side },
            h('div', { style: { ...hint, fontWeight: 600, padding: '0 4px 6px' } }, '系统提示词'),
            h(
              'button',
              { style: sideItem(selection === 'global'), onClick: () => setSelection('global') },
              h('span', null, '纯净模式提示词'),
              h('span', { style: tag }, '默认'),
            ),
            h(
              'button',
              { style: sideItem(selection === 'tools'), onClick: () => setSelection('tools') },
              h('span', null, '纯净模式工具'),
              toolSelected.length > 0 ? h('span', { style: tag }, String(toolSelected.length)) : null,
            ),
            h('div', { style: { ...hint, padding: '10px 4px 2px' } }, '会话'),
            h('input', {
              style: {
                ...btn,
                width: '100%',
                boxSizing: 'border-box',
                textAlign: 'left',
                padding: '5px 8px',
                marginBottom: 4,
              },
              placeholder: '搜索标题 / id',
              value: query,
              onChange: (e) => setQuery(e.target.value),
            }),
            filtered.length === 0
              ? h(
                  'div',
                  { style: { ...hint, padding: '6px 4px' } },
                  sessions.length === 0 ? '（没有可读的会话）' : '（无匹配）',
                )
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
                  pureItems.length > 0 ? h('div', { style: groupTitle('纯净模式', false) }, '纯净模式') : null,
                  pureItems.map(renderItem),
                  otherItems.length > 0 ? h('div', { style: groupTitle('其他会话', true) }, '其他会话') : null,
                  otherItems.map(renderItem),
                ),
          ),
          h(
            'section',
            { style: main },
            h(
              'div',
              { style: { ...row, justifyContent: 'space-between' } },
              h(
                'div',
                { style: { minWidth: 0 } },
                h(
                  'div',
                  { style: { fontWeight: 600, fontSize: 15 } },
                  isTools ? '纯净模式工具' : isSession ? current?.title || '会话提示词' : '纯净模式提示词',
                ),
                h(
                  'div',
                  { style: hint },
                  isTools
                    ? '勾选后纯净模式会话可用这些工具；不勾选 = 零工具'
                    : isSession
                      ? `${current?.title || '会话'}　${current?.cwd || ''}`.trim()
                      : '所有纯净模式会话的默认提示词（没有会话覆盖时生效）',
                ),
                h(
                  'div',
                  {
                    style: {
                      ...hint,
                      opacity: 0.8,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      wordBreak: 'break-all',
                    },
                  },
                  `来源：${
                    readOnlyView
                      ? shortenPath(systemView?.log)
                      : isTools
                        ? toolSelectionFileHint()
                        : shortenPath(sourcePath)
                  }`,
                ),
              ),
              h(
                'div',
                { style: row },
                h('button', { style: btn, onClick: refresh, disabled: busy }, '刷新'),
                isSession && hasOverride
                  ? h('button', { style: btn, onClick: reset, disabled: busy }, '删除覆盖')
                  : null,
                h('button', { style: btnPrimary, onClick: save, disabled: busy || readOnlyView }, busy ? '处理中…' : '保存'),
              ),
            ),

            isTools
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 } },
                  toolCatalog.map((group) =>
                    h(
                      'div',
                      { key: group.group, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      h('div', { style: { ...hint, fontWeight: 600, opacity: 0.7 } }, group.group),
                      h(
                        'div',
                        { style: { display: 'flex', flexWrap: 'wrap', gap: '8px 18px' } },
                        group.items.map((item) =>
                          h(
                            'label',
                            {
                              key: item.name,
                              style: {
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 12,
                                cursor: 'pointer',
                              },
                            },
                            h('input', {
                              type: 'checkbox',
                              checked: toolSelected.includes(item.name),
                              onChange: (e) =>
                                setToolSelected((prev) =>
                                  e.target.checked
                                    ? [...new Set([...prev, item.name])]
                                    : prev.filter((name) => name !== item.name),
                                ),
                            }),
                            h('span', null, item.label),
                            h('span', { style: tag }, item.name),
                          ),
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: hint },
                    toolSelected.length === 0
                      ? '当前：一个工具都不给（模型只能说话）'
                      : `当前已选 ${toolSelected.length} 个：${toolSelected.join(', ')}`,
                  ),
                )
              : readOnlyView
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 } },
                  h(
                    'div',
                    { style: hint },
                    `该会话不是纯净模式（preset: ${systemView.preset}）。下面是它实际收到的系统提示词，只读。`,
                  ),
                  h('div', { style: readOnly }, systemView.system || '（空）'),
                  h(
                    'div',
                    { style: hint },
                    `${systemView.bytes ?? 0} 字节 · 来源：会话日志的 system/message${
                      systemView.error ? ` · ${systemView.error}` : ''
                    }`,
                  ),
                )
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 } },
                  h('textarea', {
                    style: textarea,
                    value: text,
                    spellCheck: false,
                    placeholder: isSession
                      ? '本会话专用的提示词；留空并保存 = 跟随纯净模式提示词'
                      : '纯净模式提示词；留空 = 真的零提示词',
                    onChange: (e) => setText(e.target.value),
                  }),
                  h(
                    'div',
                    { style: row },
                    h(
                      'div',
                      { style: hint },
                      isSession
                        ? hasOverride
                          ? `本会话有独立覆盖　字符 ${text.length}`
                          : `当前继承纯净模式提示词（下面是它的内容，编辑后保存会为本会话创建覆盖）　字符 ${text.length}`
                        : `字符 ${text.length}　${hasOverride ? '已设置' : '未设置（= 空提示词）'}`,
                    ),
                  ),
                ),

            // 装配结果：这一条会话「实际发给模型」的 system（来自会话日志的 system/message）。
            // 和上面的配置内容不同时，说明有第三方在装配后注入 —— 这里能直接看见。
            isSession
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '0 0 auto' } },
                  h(
                    'div',
                    { style: { ...hint, fontWeight: 600, opacity: 0.7 } },
                    systemView && typeof systemView.system === 'string'
                      ? `装配结果（实际发给模型的 system）：${systemView.bytes ?? systemView.system.length} 字节`
                      : '装配结果：这个会话还没有装配记录（还没发过消息）',
                  ),
                  systemView && typeof systemView.system === 'string'
                    ? h(
                        'div',
                        {
                          style: {
                            ...readOnly,
                            minHeight: 90,
                            maxHeight: 220,
                            fontSize: 11,
                            flex: '0 0 auto',
                          },
                        },
                        systemView.system.length > 0 ? systemView.system : '（空）',
                      )
                    : null,
                )
              : null,

            status ? h('div', { style: { ...hint, opacity: 0.9 } }, status) : null,
            h(
              'div',
              { style: hint },
              isTools
                ? '工具选择对所有纯净模式会话生效，下一轮装配即生效。未勾选的工具 schema 不会进入请求，模型看不到也就调不了。'
                : '生效规则：会话覆盖 > 纯净模式提示词 > 空。保存后下一轮装配生效，不需要重启；会话覆盖只对这一条会话的纯净模式有效。',
            ),
          ),
        ),
      )
    }

    /**
     * 侧栏面板栏的图标。
     * 宿主自己画按钮与 label（ownerProps 只有 size / active），这里只提供图标本身。
     * 画成「双环 + 中心点」，与插件 / 自动化任务的单线图标在形状上区分开。
     */
    function PanelIcon({ size = 16 } = {}) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 8, cy: 8, r: 3.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1 }),
        h('circle', { cx: 8, cy: 8, r: 1.5, fill: 'currentColor' }),
      )
    }

    /**
     * 兜底：有的插件用 DOM 注入往侧栏里塞按钮，每次热重载都会多插一个。
     * 这里只写一条 CSS，把同一位置第 2 个及以后的同名节点隐藏掉，不动任何 JS。
     */
    function ensureDuplicateStyle() {
      try {
        if (document.getElementById('dsh-pure-mode-css')) return
        const style = document.createElement('style')
        style.id = 'dsh-pure-mode-css'
        style.textContent =
          '[data-sd-trash-slot] ~ [data-sd-trash-slot]{display:none!important}'
        ;(document.head || document.documentElement).appendChild(style)
      } catch {
        /* ignore */
      }
    }

    function apply(ctx) {
      ensureDuplicateStyle()
      report('apply', { hasSlots: !!ctx.slots })
      const seats = [
        { slot: 'main', opts: { name: 'main', key: 'pure-mode' }, component: PromptManager },
        {
          slot: 'sidebar.panellist',
          opts: { name: 'sidebar.panellist', id: 'pure-mode', order: -100, label: '纯净模式' },
          component: PanelIcon,
        },
      ]
      for (const seat of seats) {
        try {
          ctx.slots.inject(seat.slot, () => ctx.slots.register(seat.opts, seat.component))
          report('injected', { name: seat.slot })
        } catch (error) {
          report('inject-error', { name: seat.slot, message: String((error && error.message) || error) })
        }
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
