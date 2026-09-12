/**
 * dsh-session-status — 浏览器 bundle（自包含，无跨模块 import）。
 *
 * 双轨制：本文件 `exports.inject` 写 Cordis 服务名（slots / settingsScope /
 * sessions），不是 NPM 包名；package.json 的 dsh.client.inject 才写包名。
 *
 * 三块 UI：
 *  1. 头部状态 pill + 选择器 —— 注入 `conversation.session.header.utilities`
 *     （scope: session，props.sessionId 可用），点击弹出内置三态 + 自定义 + 清除。
 *  2. 会话列表行状态点 —— DOM 注入（无官方行级槽）：querySelectorAll
 *     `[role="treeitem"][aria-selected]` + 标题反查 session id +
 *     MutationObserver/RAF 节流；data-owner 自清理；标题重复行不渲染。
 *  3. 会话 hover 卡状态行 —— DOM 注入：DSH 的 hover 卡 portal 到 body
 *     （div[role="button"] + 内联 left/top 定位），按标题反查唯一会话，
 *     把插件状态标签追加进卡内容列（hoverContent），与「空闲/运行中」并列显示。
 *  4. 设置页标签管理 —— 注入 `settings.section`（scope: root），
 *     内置三态名称固定、颜色可调（overrides，点默认色即恢复）；
 *     自定义标签可增删改（名称 + 8 色板）。
 *
 * 纯逻辑（resolveLabels / assignStatus / pruneSessions ...）与
 * lib/status-store.js 同源 —— 本文件是浏览器端内联副本，通过 `__statusUtils`
 * 导出供 client-shape.test.mjs 与 status-store.test.mjs 交叉断言，防止漂移。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')

    // ---------------------------------------------------------------- i18n
    // English is the default; Chinese only when the host (or, failing that,
    // the browser) reports a zh locale. Builtin label names are translated at
    // display time — the stored data keeps its canonical (zh) names.

    var STRINGS = {
      en: {
        builtinNames: { active: 'In progress', done: 'Done', paused: 'Shelved' },
        pillTitleSet: 'Set session status (click to cycle: In progress → Done → Shelved → None)',
        pillTitleCurrent: '{name} (click to cycle: In progress → Done → Shelved → None)',
        unsetStatus: 'No status',
        chooseStatus: 'Choose status (custom labels / clear)',
        chooseStatusAria: 'Choose status',
        clearStatus: 'Clear status',
        anyColor: 'Any color #RRGGBB (or #RGB shorthand)',
        customColorAria: 'Custom color value',
        builtinTag: 'Built-in',
        resetDefault: 'Reset',
        unnamed: 'Unnamed',
        deleteLabel: 'Delete',
        settingsTitle: 'Session status labels',
        settingsBuiltinSub: 'Built-in labels (fixed names, adjustable colors)',
        settingsCustomSub: 'Custom labels',
        noCustom: 'No custom labels yet',
        newNamePlaceholder: 'New label name…',
        addLabel: 'Add',
        sectionLabel: 'Session status',
      },
      zh: {
        builtinNames: { active: '进行中', done: '已结项', paused: '搁置中' },
        pillTitleSet: '设置会话状态（点击循环：进行中 → 已结项 → 搁置中 → 无）',
        pillTitleCurrent: '{name}（点击循环：进行中 → 已结项 → 搁置中 → 无）',
        unsetStatus: '未设置状态',
        chooseStatus: '选择状态（自定义标签 / 清除）',
        chooseStatusAria: '选择状态',
        clearStatus: '清除状态',
        anyColor: '任意颜色 #RRGGBB（或 #RGB 简写）',
        customColorAria: '自定义颜色值',
        builtinTag: '内置',
        resetDefault: '恢复默认',
        unnamed: '未命名',
        deleteLabel: '删除',
        settingsTitle: '会话状态标签',
        settingsBuiltinSub: '内置标签（名称固定，颜色可调）',
        settingsCustomSub: '自定义标签',
        noCustom: '暂无自定义标签',
        newNamePlaceholder: '新标签名称…',
        addLabel: '添加',
        sectionLabel: '会话状态',
      },
    }

    var lang = 'en'
    try {
      var navLang = String((typeof navigator !== 'undefined' && navigator.language) || '')
      if (/^zh/i.test(navLang)) lang = 'zh'
    } catch (e) { /* no navigator */ }

    function T(key) {
      return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key
    }

    /** Display name for a label: builtins are localized, customs keep theirs. */
    function displayName(label) {
      if (label && label.builtin) {
        var localized = STRINGS[lang].builtinNames[label.key]
        if (localized) return localized
      }
      return label ? label.name : ''
    }

    /** Host locale sync — the snapshot shape is { active, locales, revision }. */
    function syncFromHostLocale(ctx) {
      try {
        var snap = ctx && ctx.locale && ctx.locale.snapshot && ctx.locale.snapshot()
        var code = String((snap && (snap.active || snap.locale || snap.language)) || '')
        if (/^zh/i.test(code)) lang = 'zh'
        else if (/^en/i.test(code)) lang = 'en'
      } catch (e) { /* runtime without locale service */ }
    }

    // ---------------------------------------------------------------- 纯逻辑

    var BUILTIN_LABELS = [
      { key: 'active', name: '进行中', color: '#22c55e', builtin: true },
      { key: 'done', name: '已结项', color: '#3b82f6', builtin: true },
      { key: 'paused', name: '搁置中', color: '#9ca3af', builtin: true },
    ]
    var PALETTE = [
      '#ef4444', '#f59e0b', '#8b5cf6', '#14b8a6', '#ec4899',
      '#f97316', '#06b6d4', '#a3e635',
    ]

    /** 把用户输入规范化为 #rrggbb；非法输入返回 null（支持 #RGB 简写）。 */
    function normalizeHex(value) {
      if (typeof value !== 'string') return null
      var v = value.trim()
      var long = /^#([0-9a-fA-F]{6})$/.exec(v)
      if (long) return '#' + long[1].toLowerCase()
      var short = /^#([0-9a-fA-F]{3})$/.exec(v)
      if (short) {
        var hex = short[1].toLowerCase()
        return '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
      }
      return null
    }
    var BUILTIN_KEYS = {}
    for (var bi = 0; bi < BUILTIN_LABELS.length; bi++) BUILTIN_KEYS[BUILTIN_LABELS[bi].key] = true

    function builtinDefaultColor(key) {
      for (var i = 0; i < BUILTIN_LABELS.length; i++) {
        if (BUILTIN_LABELS[i].key === key) return BUILTIN_LABELS[i].color
      }
      return undefined
    }

    /** 把内置标签的覆盖补丁应用到基线上（当前只写 color，name 预留）。 */
    function applyBuiltinOverride(label, override) {
      if (override === null || typeof override !== 'object') return label
      var out = null
      var KEYS = ['color', 'name']
      for (var i = 0; i < KEYS.length; i++) {
        var key = KEYS[i]
        if (typeof override[key] !== 'string' || override[key] === '') continue
        if (!out) out = { key: label.key, name: label.name, color: label.color, builtin: true }
        out[key] = override[key]
      }
      return out || label
    }

    function resolveLabels(value) {
      var raw = Array.isArray(value)
        ? value
        : (value !== null && typeof value === 'object' && Array.isArray(value.labels) ? value.labels : [])
      var overrides = (!Array.isArray(value) && value !== null && typeof value === 'object'
        && value.overrides !== null && typeof value.overrides === 'object')
        ? value.overrides
        : {}
      var seen = {}
      var merged = []
      for (var i = 0; i < BUILTIN_LABELS.length; i++) {
        merged.push(applyBuiltinOverride(BUILTIN_LABELS[i], overrides[BUILTIN_LABELS[i].key]))
        seen[BUILTIN_LABELS[i].key] = true
      }
      for (var j = 0; j < raw.length; j++) {
        var label = raw[j]
        if (label === null || typeof label !== 'object') continue
        if (typeof label.key !== 'string' || seen[label.key]) continue
        if (typeof label.name !== 'string' || label.name === '') continue
        if (typeof label.color !== 'string' || label.color === '') continue
        seen[label.key] = true
        merged.push({
          key: label.key, name: label.name, color: label.color, builtin: false,
          icon: typeof label.icon === 'string' ? label.icon : undefined,
        })
      }
      return merged
    }

    function findLabel(labels, key) {
      if (!Array.isArray(labels)) return undefined
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].key === key) return labels[i]
      }
      return undefined
    }

    function labelIconKey(key) {
      switch (key) {
        case 'active': return 'bolt'
        case 'done': return 'check'
        case 'paused': return 'pause'
        default: return 'tag'
      }
    }

    var LABEL_ICONS = [
      'tag', 'flag', 'star', 'fire', 'clock', 'bookmark', 'rocket',
      'target', 'pin', 'bell', 'bolt', 'check', 'pause',
    ]

    function resolveLabelIcon(label) {
      if (label === null || typeof label !== 'object' || typeof label.key !== 'string') return 'tag'
      if (label.key === 'active' || label.key === 'done' || label.key === 'paused') {
        return labelIconKey(label.key)
      }
      return LABEL_ICONS.indexOf(label.icon) !== -1 ? label.icon : 'tag'
    }

    function nextSessionStatus(currentKey) {
      var ORDER = ['active', 'done', 'paused']
      if (typeof currentKey !== 'string' || currentKey === '') return 'active'
      var index = ORDER.indexOf(currentKey)
      if (index === -1) return 'active'
      return index + 1 < ORDER.length ? ORDER[index + 1] : null
    }

    function assignStatus(sessions, sessionId, key) {
      var next = {}
      var src = sessions || {}
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k]
      if (key === null || key === undefined || key === '') {
        delete next[sessionId]
      } else {
        next[sessionId] = key
      }
      return next
    }

    function pruneSessions(sessions, liveSessionIds) {
      if (sessions === null || sessions === undefined) return undefined
      var next = {}
      var changed = false
      for (var id in sessions) {
        if (!Object.prototype.hasOwnProperty.call(sessions, id)) continue
        if (liveSessionIds.has(id)) next[id] = sessions[id]
        else changed = true
      }
      return changed ? next : undefined
    }

    function setOverride(overrides, key, patch) {
      var next = {}
      var src = overrides || {}
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k]
      next[key] = Object.assign({}, next[key] || {}, patch)
      return next
    }

    function clearOverride(overrides, key) {
      if (overrides === null || overrides === undefined) return undefined
      var next = {}
      for (var k in overrides) {
        if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue
        if (k === key) continue
        next[k] = overrides[k]
      }
      return Object.keys(next).length === 0 ? undefined : next
    }

    function generateLabelKey(name, existingKeys) {
      var base = String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      var safe = /^[a-z]/.test(base) ? base : 'label-' + (base || 'custom')
      var key = safe
      var index = 2
      while (existingKeys.has(key)) {
        key = safe + '-' + index
        index += 1
      }
      return key
    }

    function nextPaletteColor(labels) {
      var used = {}
      var list = labels || []
      for (var i = 0; i < list.length; i++) used[list[i].color] = true
      for (var j = 0; j < PALETTE.length; j++) {
        if (!used[PALETTE[j]]) return PALETTE[j]
      }
      return PALETTE[0]
    }

    var __statusUtils = {
      resolveLabels, findLabel, labelIconKey, resolveLabelIcon, LABEL_ICONS,
      nextSessionStatus, assignStatus, pruneSessions, generateLabelKey, nextPaletteColor,
      builtinDefaultColor, setOverride, clearOverride, normalizeHex,
      /** Language override used by tests / locale-change handler. */
      setLang: function (next) { if (STRINGS[next]) lang = next },
      getLang: function () { return lang },
      t: T, displayName,
    }

    // ------------------------------------------------------------ 共享状态

    var scopeRef = { scope: null }   // settingsScope.bind 的结果
    var sessionsRef = { list: null } // ctx.sessions.list（ObservableSnapshot）

    // ------------------------------------------------------------ 工具函数

    function ownNodeSelector() {
      return '[data-owner="dsh-session-status"]'
    }

    function removeOwnNodes() {
      var nodes = document.querySelectorAll(ownNodeSelector())
      for (var i = 0; i < nodes.length; i++) nodes[i].remove()
    }

    /** 当前会话 id 集合；列表未就绪（phase !== 'ready'）时返回 null（不清理）。 */
    function liveSessionIds() {
      var list = sessionsRef.list ? sessionsRef.list.getSnapshot() : null
      if (!list || list.phase !== 'ready') return null
      return new Set(list.ids || [])
    }

    /** 把 sessionId 的状态设为 key（null 清除），带惰性清理后写 settings。 */
    function setSessionStatus(sessionId, key) {
      if (!scopeRef.scope || !sessionId) return
      var snap = scopeRef.scope.getSnapshot()
      var value = snap.status === 'ready' && snap.value ? snap.value : null
      var sessions = (value && value.sessions) || {}
      var live = liveSessionIds()
      var base = live ? (pruneSessions(sessions, live) || sessions) : sessions
      var next = assignStatus(base, sessionId, key)
      if (Object.keys(next).length === 0) {
        scopeRef.scope.unset('sessions')
      } else {
        scopeRef.scope.set('sessions', next)
      }
    }

    /** 写入自定义标签列表（不含内置；空则 unset，保持文档干净）。 */
    function writeLabels(nextLabels) {
      if (!scopeRef.scope) return
      var merged = resolveLabels(nextLabels)
      var customs = merged.filter(function (label) { return !label.builtin })
      if (customs.length === 0) {
        scopeRef.scope.unset('labels')
      } else {
        scopeRef.scope.set('labels', customs)
      }
    }

    /** 写入内置标签颜色覆盖；color 等于默认色时清除该覆盖（空映射 unset 不落盘）。 */
    function writeBuiltinOverride(key, color) {
      if (!scopeRef.scope || !key) return
      var snap = scopeRef.scope.getSnapshot()
      var value = snap.status === 'ready' && snap.value ? snap.value : null
      var overrides = (value && value.overrides) || {}
      if (color === builtinDefaultColor(key) || !color) {
        var next = clearOverride(overrides, key)
        if (next) scopeRef.scope.set('overrides', next)
        else scopeRef.scope.unset('overrides')
      } else {
        scopeRef.scope.set('overrides', setOverride(overrides, key, { color: color }))
      }
    }

    // ------------------------------------------------- 列表行 DOM 注入（2）

    /** 会话列表 → 标题 → session id 列表（空白会话不参与；重复标题保留多条，渲染时跳过）。 */
    function buildTitleMap(list) {
      var byTitle = new Map()
      var ids = list.ids || []
      for (var i = 0; i < ids.length; i++) {
        var summary = list.byId[ids[i]]
        if (!summary || summary.blank) continue
        var title = summary.displayTitle
        var arr = byTitle.get(title)
        if (arr) arr.push(ids[i])
        else byTitle.set(title, [ids[i]])
      }
      return byTitle
    }

    function findTitleElement(row, byTitle) {
      var spans = row.querySelectorAll('span')
      for (var i = 0; i < spans.length; i++) {
        var text = spans[i].textContent.trim()
        if (text !== '' && byTitle.has(text)) return spans[i]
      }
      return null
    }

    function insertDot(row, dot) {
      var slot = null
      for (var i = 0; i < row.children.length; i++) {
        var child = row.children[i]
        if (child.className && String(child.className).indexOf('slot') !== -1) {
          slot = child
          break
        }
      }
      if (slot && slot.parentNode === row) row.insertBefore(dot, slot)
      else row.insertBefore(dot, row.firstChild)
    }

    function renderRowDots() {
      if (!scopeRef.scope) return
      removeOwnNodes()
      var snap = scopeRef.scope.getSnapshot()
      if (snap.status !== 'ready' || !snap.value) return
      var list = sessionsRef.list ? sessionsRef.list.getSnapshot() : null
      if (!list || list.phase !== 'ready') return
      var value = snap.value
      var labels = resolveLabels(value)
      var sessionsMap = value.sessions || {}
      // 标题 → session id 列表（空白会话不参与；重复标题在渲染时跳过）
      var byTitle = buildTitleMap(list)
      if (byTitle.size === 0) return
      var rows = document.querySelectorAll('[role="treeitem"][aria-selected]')
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r]
        var titleEl = findTitleElement(row, byTitle)
        if (!titleEl) continue
        var title = titleEl.textContent.trim()
        var matches = byTitle.get(title)
        if (!matches || matches.length !== 1) continue // 未知或标题重复：宁可漏，不可错
        var labelKey = sessionsMap[matches[0]]
        if (!labelKey) continue
        var label = findLabel(labels, labelKey)
        if (!label) continue
        var mark = document.createElement('span')
        mark.setAttribute('data-owner', 'dsh-session-status')
        mark.setAttribute('data-session-id', matches[0])
        mark.setAttribute('data-status-key', labelKey)
        mark.title = displayName(label)
        mark.innerHTML = iconSvgMarkup(resolveLabelIcon(label), label.color, 12)
        mark.style.cssText = 'display:inline-flex;align-items:center;flex:none;margin:0 2px;'
        insertDot(row, mark)
      }
    }

    function installRowDots() {
      var observers = []
      var rafId = 0
      var onReady = null
      function schedule() {
        if (rafId) return
        rafId = requestAnimationFrame(function () {
          rafId = 0
          renderAll()
        })
      }
      function startObserving() {
        if (!document.body) return
        var observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        observers.push(observer)
        schedule()
      }
      if (document.readyState === 'loading') {
        onReady = startObserving
        document.addEventListener('DOMContentLoaded', onReady)
      } else {
        startObserving()
      }
      return function cleanup() {
        if (onReady) document.removeEventListener('DOMContentLoaded', onReady)
        for (var i = 0; i < observers.length; i++) observers[i].disconnect()
        if (rafId) cancelAnimationFrame(rafId)
        removeOwnNodes()
      }
    }

    // ----------------------------------------- hover 卡状态注入（1b）

    function removeHoverNodes() {
      var nodes = document.querySelectorAll('[data-owner="dsh-session-status"][data-owner-part="hover"]')
      for (var i = 0; i < nodes.length; i++) nodes[i].remove()
    }

    /**
     * 在 root 内找 textContent.trim() 精确等于 text 的元素（取文档序最后一个 = 最深）。
     * hover 卡的标题行是纯文本 div（无子元素），匹配唯一。
     */
    function findExactTextElement(root, text) {
      var all = typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : []
      var best = null
      for (var i = 0; i < all.length; i++) {
        if ((all[i].textContent || '').trim() === text) best = all[i]
      }
      return best
    }

    /**
     * 判定一个 portal 的 hover 卡是否对应某个唯一会话，返回其内容容器（标题行的父节点
     * = DSH 的 hoverContent 列）。判据：内联 fixed 定位样式（left/top）+ 正文含唯一会话标题。
     * 工作区卡的路径文本恰好等于某会话标题的概率极低，且 byTitle 要求标题唯一，误命中可忽略。
     * @returns {container, ids} | null
     */
    function findHoverAnchor(card, byTitle) {
      var style = typeof card.getAttribute === 'function' ? (card.getAttribute('style') || '') : ''
      if (style.indexOf('left:') === -1 || style.indexOf('top:') === -1) return null
      var text = card.textContent || ''
      var entries = Array.from(byTitle.entries ? byTitle.entries() : [])
      for (var i = 0; i < entries.length; i++) {
        var title = entries[i][0]
        var ids = entries[i][1]
        if (title === '' || text.indexOf(title) === -1) continue
        var titleEl = findExactTextElement(card, title)
        if (!titleEl || !titleEl.parentElement) continue
        return { container: titleEl.parentElement, ids: ids }
      }
      return null
    }

    /** 共享的状态上下文：标签解析 + 会话映射 + 标题反查表（列表未就绪返回 null）。 */
    function collectStatusContext() {
      if (!scopeRef.scope) return null
      var snap = scopeRef.scope.getSnapshot()
      if (snap.status !== 'ready' || !snap.value) return null
      var list = sessionsRef.list ? sessionsRef.list.getSnapshot() : null
      if (!list || list.phase !== 'ready') return null
      return {
        labels: resolveLabels(snap.value),
        sessionsMap: snap.value.sessions || {},
        byTitle: buildTitleMap(list),
      }
    }

    /**
     * 把当前会话的插件状态标签注入 DSH 的 hover 卡（portal 到 body 的复制卡，
     * role=button + 内联 left/top 定位）。与列表行同款护栏：标题重复/未知 → 不注入。
     * 每次全量重建（data-owner 自清理），卡内容重渲染后由 MutationObserver 补回。
     */
    function renderHoverStatus() {
      if (!scopeRef.scope) return
      removeHoverNodes()
      var ctx = collectStatusContext()
      if (!ctx || ctx.byTitle.size === 0) return
      var cards = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('div[role="button"]') : []
      for (var c = 0; c < cards.length; c++) {
        var hit = findHoverAnchor(cards[c], ctx.byTitle)
        if (!hit || hit.ids.length !== 1) continue
        var labelKey = ctx.sessionsMap[hit.ids[0]]
        if (!labelKey) continue
        var label = findLabel(ctx.labels, labelKey)
        if (!label) continue
        var line = document.createElement('div')
        line.setAttribute('data-owner', 'dsh-session-status')
        line.setAttribute('data-owner-part', 'hover')
        line.setAttribute('data-session-id', hit.ids[0])
        line.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;color:#ADB2B8;'
        var icon = document.createElement('span')
        icon.style.cssText = 'display:inline-flex;align-items:center;flex:none;'
        icon.innerHTML = iconSvgMarkup(resolveLabelIcon(label), label.color, 12)
        var name = document.createElement('span')
        name.textContent = displayName(label)
        line.appendChild(icon)
        line.appendChild(name)
        hit.container.appendChild(line)
      }
    }

    /** 列表行状态点 + hover 卡状态的统一重渲染（scope/sessions 变更与 DOM 变化都走这里）。 */
    function renderAll() {
      renderRowDots()
      renderHoverStatus()
    }

    // ------------------------------------------------- 头部 pill + 选择器（1）

    var pillStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      height: '22px',
      padding: '0 8px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #888)',
      fontSize: '11px',
      lineHeight: '1',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      fontFamily: 'inherit',
    }

    var menuStyle = {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      right: '0',
      minWidth: '150px',
      padding: '4px',
      borderRadius: '8px',
      background: 'var(--dsw-specific-menu, #1f2937)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
      boxShadow: 'var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,0.35))',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
    }

    var itemStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      padding: '6px 8px',
      borderRadius: '6px',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-primary, #ddd)',
      cursor: 'pointer',
      fontFamily: 'inherit',
      background: 'transparent',
      border: 'none',
      textAlign: 'left',
      width: '100%',
    }

    // 下拉箭头：与 pill 拼成一体（负 margin 覆盖分隔线），仅负责开合选择菜单。
    var caretStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      height: '22px',
      padding: '0 5px',
      marginLeft: '-1px',
      border: 'none',
      borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
      borderRadius: '0 999px 999px 0',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #777)',
      fontSize: '9px',
      lineHeight: '1',
      cursor: 'pointer',
      fontFamily: 'inherit',
    }

    /**
     * 标签象征 icon 的 SVG 标记（Material 风格 path，viewBox 24，颜色由标签色填充）。
     * 用 icon 而非圆点，避免与 DSH 内置会话运行状态点（黄/绿）视觉重复。
     * @param name - 'bolt' | 'check' | 'pause' | 'tag'。
     * @param color - 填充色（标签颜色）。
     * @param size - 边长像素。
     */
    function iconSvgMarkup(name, color, size) {
      var s = size || 12
      var inner
      switch (name) {
        case 'bolt': // 闪电：进行中
          inner = '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>'
          break
        case 'check': // 对勾：已结项
          inner = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
          break
        case 'pause': // 暂停符：搁置中
          inner = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
          break
        case 'flag':
          inner = '<path d="M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z"/>'
          break
        case 'star':
          inner = '<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>'
          break
        case 'fire':
          inner = '<path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/>'
          break
        case 'clock':
          inner = '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>'
          break
        case 'bookmark':
          inner = '<path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>'
          break
        case 'rocket':
          inner = '<path d="M9.19 6.35c-2.04 2.29-3.44 5.58-3.57 5.89l-.55 1.18c-.02.06 0 .11.04.15l3.97 3.97c.04.04.09.06.15.04l1.18-.55c.31-.13 3.6-1.53 5.89-3.57L9.19 6.35zM20.66 3.34c-3.36-1.16-6.86.13-9.75 3.02-1.74 1.74-3.18 3.94-4.19 6.13-.24.51-.12 1.1.28 1.5l3.05 3.05c.4.4.99.52 1.5.28 2.19-1.01 4.39-2.45 6.13-4.19 2.89-2.89 4.18-6.39 3.02-9.75-.11-.32-.41-.54-.75-.54-.07 0-.18 0-.29.02zM6.59 15.41c-.35-.35-1.15-.09-1.5.25L3.3 18.45c-.4.4-.4 1.04 0 1.44l.81.81c.4.4 1.04.4 1.44 0l2.79-2.79c.34-.35.6-1.15.25-1.5z"/>'
          break
        case 'target':
          inner = '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 9c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>'
          break
        case 'pin':
          inner = '<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>'
          break
        case 'bell':
          inner = '<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>'
          break
        default: // 标签形：自定义标签
          inner = '<path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>'
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="' + color + '" style="display:block">' + inner + '</svg>'
    }

    /** React 侧的 icon 包裹 span（flex none，供 pill/菜单/设置页复用）。 */
    function iconSpan(name, color, size) {
      return react.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', flex: 'none' },
        dangerouslySetInnerHTML: { __html: iconSvgMarkup(name, color, size) },
      })
    }

    function StatusPill(props) {
      var sessionId = props && props.sessionId
      var tick = react.useReducer(function (x) { return x + 1 }, 0)
      var bump = tick[1]
      var openState = react.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var menuRef = react.useRef(null)

      react.useEffect(function () {
        var offScope = scopeRef.scope ? scopeRef.scope.subscribe(bump) : null
        var offSessions = sessionsRef.list ? sessionsRef.list.subscribe(bump) : null
        function onDocClick(event) {
          if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false)
        }
        if (open) document.addEventListener('click', onDocClick)
        return function () {
          if (offScope) offScope()
          if (offSessions) offSessions()
          document.removeEventListener('click', onDocClick)
        }
      })

      var snap = scopeRef.scope ? scopeRef.scope.getSnapshot() : null
      var value = snap && snap.status === 'ready' && snap.value ? snap.value : null
      var labels = resolveLabels(value || {})
      var sessionsMap = (value && value.sessions) || {}
      var currentKey = typeof sessionId === 'string' ? sessionsMap[sessionId] : undefined
      var current = currentKey ? findLabel(labels, currentKey) : undefined

      if (typeof sessionId !== 'string' || sessionId === '') return null

      var pill = react.createElement('button', {
        type: 'button',
        style: pillStyle,
        title: current ? T('pillTitleCurrent').replace('{name}', displayName(current)) : T('pillTitleSet'),
        onClick: function (event) {
          event.stopPropagation()
          setSessionStatus(sessionId, nextSessionStatus(currentKey))
        },
      }, current
        ? [iconSpan(resolveLabelIcon(current), current.color, 10), displayName(current)]
        : [iconSpan('tag', '#9ca3af', 10), T('unsetStatus')])

      var caret = react.createElement('button', {
        type: 'button',
        style: caretStyle,
        title: T('chooseStatus'),
        'aria-label': T('chooseStatusAria'),
        onClick: function (event) {
          event.stopPropagation()
          setOpen(!open)
        },
      }, '▾')

      if (!open) {
        return react.createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
          pill, caret)
      }

      var items = []
      for (var i = 0; i < labels.length; i++) {
        ;(function (label) {
          var selected = currentKey === label.key
          items.push(react.createElement('button', {
            key: label.key,
            type: 'button',
            style: Object.assign({}, itemStyle, selected ? { background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15))' } : {}),
            onClick: function (event) {
              event.stopPropagation()
              setOpen(false)
              setSessionStatus(sessionId, label.key)
            },
          }, iconSpan(resolveLabelIcon(label), label.color, 12), react.createElement('span', { style: { flex: '1' } }, displayName(label)),
            selected ? react.createElement('span', { style: { fontSize: '11px', color: label.color } }, '✓') : null))
        })(labels[i])
      }
      items.push(react.createElement('div', { key: 'sep', style: { height: '1px', margin: '3px 4px', background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.4))' } }))
      items.push(react.createElement('button', {
        key: 'clear',
        type: 'button',
        style: Object.assign({}, itemStyle, { color: 'var(--dsw-alias-label-tertiary, #777)' }),
        onClick: function (event) {
          event.stopPropagation()
          setOpen(false)
          setSessionStatus(sessionId, null)
        },
      }, react.createElement('span', { style: { flex: '1' } }, T('clearStatus'))))

      return react.createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
        pill, caret,
        react.createElement('div', { ref: menuRef, style: menuStyle }, items))
    }

    // --------------------------------------------------- 设置页标签管理（3）

    function SettingsSection(props) {
      var tick = react.useReducer(function (x) { return x + 1 }, 0)
      var bump = tick[1]
      var nameDraft = react.useState('')
      var draft = nameDraft[0]
      var setDraft = nameDraft[1]
      var colorState = react.useState(PALETTE[0])
      var colorPick = colorState[0]
      var setColorPick = colorState[1]
      var iconState = react.useState('tag')
      var iconPick = iconState[0]
      var setIconPick = iconState[1]

      react.useEffect(function () {
        var off = scopeRef.scope ? scopeRef.scope.subscribe(bump) : null
        return function () { if (off) off() }
      }, [])

      var snap = scopeRef.scope ? scopeRef.scope.getSnapshot() : null
      var value = snap && snap.status === 'ready' && snap.value ? snap.value : null
      var labels = resolveLabels(value || {})
      var builtins = labels.filter(function (label) { return label.builtin })
      var customs = labels.filter(function (label) { return !label.builtin })
      var overrides = (value && value.overrides) || {}

      function isBuiltinOverridden(key) {
        var def = builtinDefaultColor(key)
        var ov = overrides[key]
        return !!(ov && ov.color && ov.color !== def)
      }

      function existingKeys() {
        var set = new Set()
        for (var i = 0; i < labels.length; i++) set.add(labels[i].key)
        return set
      }

      function commitCustomLabel(label) {
        var next = customs.map(function (l) { return l.key === label.key ? label : l })
        writeLabels(next)
      }

      function removeCustomLabel(key) {
        writeLabels(customs.filter(function (label) { return label.key !== key }))
      }

      function addLabel() {
        var name = draft.trim()
        if (name === '') return
        var key = generateLabelKey(name, existingKeys())
        writeLabels(customs.concat([{ key: key, name: name, color: colorPick, icon: iconPick }]))
        setDraft('')
        setColorPick(nextPaletteColor(labels))
        setIconPick('tag')
      }

      function swatchRow(onPick, current) {
        return PALETTE.map(function (color) {
          var active = color === current
          return react.createElement('button', {
            key: color,
            type: 'button',
            title: color,
            style: {
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              border: active ? '2px solid var(--dsw-alias-label-primary, #fff)' : '1px solid rgba(128,128,128,0.4)',
              background: color,
              cursor: 'pointer',
              padding: '0',
            },
            onClick: function () { onPick(color) },
          })
        })
      }

      /** 自定义标签 icon 选择器（LABEL_ICONS 全部可选，选中项高亮）。 */
      function iconRow(onPick, current, size) {
        var s = size || 13
        return react.createElement('div', { style: { display: 'flex', gap: '3px', flexWrap: 'wrap' } },
          LABEL_ICONS.map(function (iconName) {
            var active = iconName === current
            return react.createElement('button', {
              key: iconName,
              type: 'button',
              title: iconName,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: s + 10,
                height: s + 10,
                border: active
                  ? '1.5px solid var(--dsw-alias-label-primary, #fff)'
                  : '1px solid rgba(128,128,128,0.35)',
                borderRadius: '6px',
                background: 'transparent',
                cursor: 'pointer',
                padding: '2px',
              },
              dangerouslySetInnerHTML: {
                __html: iconSvgMarkup(iconName, active ? '#ddd' : '#999', s),
              },
              onClick: function () { onPick(iconName) },
            })
          }))
      }

      /**
       * 任意十六进制颜色输入：失焦/回车提交（规范化后），非法输入回退当前色。
       * 外部颜色变化（点色板）时同步草稿。
       */
      function ColorHexInput(props) {
        var draftState = react.useState(props.color)
        var draft = draftState[0]
        var setDraft = draftState[1]
        react.useEffect(function () { setDraft(props.color) }, [props.color])
        function commit() {
          var hex = normalizeHex(draft)
          if (hex) props.onCommit(hex)
          else setDraft(props.color)
        }
        return react.createElement('input', {
          style: Object.assign({}, inputStyle, { width: '82px', padding: '4px 6px', fontFamily: 'monospace' }),
          value: draft,
          title: T('anyColor'),
          'aria-label': T('customColorAria'),
          onChange: function (event) { setDraft(event.target.value) },
          onBlur: commit,
          onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur() },
        })
      }

      var headerStyle = { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #ddd)', margin: '0 0 10px' }
      var subStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', margin: '14px 0 6px' }
      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }
      var inputStyle = {
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
        borderRadius: '6px',
        color: 'var(--dsw-alias-label-primary, #ddd)',
        fontSize: '12px',
        padding: '4px 8px',
        fontFamily: 'inherit',
      }
      var btnStyle = {
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
        borderRadius: '6px',
        color: 'var(--dsw-alias-label-secondary, #aaa)',
        fontSize: '12px',
        padding: '4px 10px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }

      var builtinRows = builtins.map(function (label) {
        return react.createElement('div', { key: label.key, style: { padding: '2px 0' } },
          react.createElement('div', { style: rowStyle },
            iconSpan(resolveLabelIcon(label), label.color, 12),
            react.createElement('span', { style: { flex: '1' } }, displayName(label)),
            react.createElement('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #777)' } }, T('builtinTag')),
            isBuiltinOverridden(label.key)
              ? react.createElement('button', {
                type: 'button',
                style: Object.assign({}, btnStyle, { fontSize: '11px', padding: '2px 8px' }),
                onClick: function () { writeBuiltinOverride(label.key, builtinDefaultColor(label.key)) },
              }, T('resetDefault'))
              : null),
          react.createElement('div', { style: Object.assign({}, rowStyle, { marginLeft: '20px' }) },
            swatchRow(function (color) { writeBuiltinOverride(label.key, color) }, label.color)))
      })

      var customRows = customs.map(function (label) {
        return react.createElement('div', { key: label.key, style: { padding: '2px 0' } },
          react.createElement('div', { style: rowStyle },
            iconSpan(resolveLabelIcon(label), label.color, 12),
            react.createElement('input', {
              style: Object.assign({}, inputStyle, { flex: '1', minWidth: '80px' }),
              value: label.name,
              onChange: function (event) {
                commitCustomLabel({ key: label.key, name: event.target.value, color: label.color, icon: label.icon })
              },
              onBlur: function () {
                if (label.name.trim() === '') commitCustomLabel({ key: label.key, name: T('unnamed'), color: label.color, icon: label.icon })
              },
            }),
            react.createElement('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
              swatchRow(function (color) { commitCustomLabel({ key: label.key, name: label.name, color: color, icon: label.icon }) }, label.color),
              react.createElement(ColorHexInput, {
                color: label.color,
                onCommit: function (color) { commitCustomLabel({ key: label.key, name: label.name, color: color, icon: label.icon }) },
              })),
            react.createElement('button', {
              type: 'button',
              style: Object.assign({}, btnStyle, { color: 'var(--dsw-alias-state-error-primary, #f87171)' }),
              onClick: function () { removeCustomLabel(label.key) },
            }, T('deleteLabel'))),
          react.createElement('div', { style: Object.assign({}, rowStyle, { marginLeft: '20px' }) },
            iconRow(function (iconName) { commitCustomLabel({ key: label.key, name: label.name, color: label.color, icon: iconName }) }, resolveLabelIcon(label))))
      })

      return react.createElement('div', { style: { padding: '4px 2px' } },
        react.createElement('div', { style: headerStyle }, T('settingsTitle')),
        react.createElement('div', { style: subStyle }, T('settingsBuiltinSub')),
        builtinRows,
        react.createElement('div', { style: subStyle }, T('settingsCustomSub')),
        customRows.length === 0
          ? react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #777)', padding: '4px 0' } }, T('noCustom'))
          : customRows,
        react.createElement('div', { style: Object.assign({}, rowStyle, { marginTop: '10px', flexWrap: 'wrap' }) },
          react.createElement('input', {
            style: Object.assign({}, inputStyle, { flex: '1', minWidth: '120px' }),
            placeholder: T('newNamePlaceholder'),
            value: draft,
            onChange: function (event) { setDraft(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') addLabel() },
          }),
          react.createElement('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
            swatchRow(setColorPick, colorPick),
            react.createElement(ColorHexInput, { color: colorPick, onCommit: setColorPick })),
          react.createElement('button', { type: 'button', style: btnStyle, onClick: addLabel }, T('addLabel'))),
        react.createElement('div', { style: Object.assign({}, rowStyle, { marginTop: '4px' }) },
          react.createElement('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #777)' } }, 'icon'),
          iconRow(setIconPick, iconPick))
      )
    }

    // ---------------------------------------------------------------- apply

    var inject = ['slots', 'settingsScope', 'sessions', 'locale']

    function apply(ctx) {
      syncFromHostLocale(ctx)
      try {
        ctx.on('locale/change', function () {
          var before = lang
          syncFromHostLocale(ctx)
          if (lang !== before) renderAll()
        })
      } catch (e) { /* no locale events */ }
      var scope = ctx.settingsScope.bind({ namespace: 'dsh-session-status' })
      scopeRef.scope = scope
      sessionsRef.list = ctx.sessions.list

      var disposers = []
      disposers.push(scope.subscribe(renderAll))
      disposers.push(ctx.sessions.list.subscribe(renderAll))
      disposers.push(installRowDots())
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]()
        }
      }, 'dsh-session-status: row dots')

      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-session-status',
          order: 100,
        }, function (props) { return react.createElement(StatusPill, props) })
      })

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'session-status',
          order: 30,
          label: T('sectionLabel'),
        }, function (props) { return react.createElement(SettingsSection, props) })
      })
    }

    exports.inject = inject
    exports.apply = apply
    exports.__statusUtils = __statusUtils
    return module.exports
  },
})
