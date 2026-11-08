/**
 * model-auto-switch — browser half.
 *
 * Contributes the editable rotation page: an ordered combo of third-party
 * models the user picks from the live catalog, a timeout threshold, a master
 * switch, and the live failover state (phase / active model / recent
 * decisions) of the host-side state machine.
 *
 * Data lives behind the plugin's own same-origin `/api/model-auto-switch/*`
 * routes rather than a typed Remote binding, because those routes are served
 * by the same host process on every kernel line this plugin targets.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  // The boot graph keys this row by PACKAGE NAME and the module system only
  // accepts a factory registered under that exact id. A bare
  // "model-auto-switch" loads but never registers, so the row is never composed
  // and the page never appears.
  id: 'dsh-model-rotation',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useCallback } = React

    const NS = 'settings.modelAutoSwitch'
    const API = '/api/model-auto-switch'

    const DICT = {
      zh: {
        'meta.title': '模型自动切换',
        'meta.description': '自定义第三方模型排序组合；限流或超时次数超过上限时自动切到下一个模型，组合耗尽后重测超时模型，最后由 DSH 本平台模型兜底。',
        title: '模型自动切换',
        subtitle: '自定义排序组合：限流立即切换，超时超过上限次数切换，组合耗尽后重测超时模型，最后由 DSH 平台模型兜底。',
        enabled: '启用',
        disabled: '已关闭',
        rotation: '成员（按顺序）',
        rotationHint: '按此顺序尝试；排在前面的优先。缓存上限、上下文等元数据来自当前模型目录。',
        empty: '还没有成员。从下面的目录里添加至少一个第三方模型。',
        addMember: '添加成员',
        name: '名称',
        namePlaceholder: '例如：先免费后协付',
        pickerTitle: '选择模型',
        search: '搜索',
        searchPlaceholder: '搜索模型 ID 或名称',
        noMatch: '没有匹配的模型',
        showVision: '显示「自动识图」变体',
        visionHint: '带「自动识图」的是同一平台的识图变体，模型相同、额外支持图片输入；不需要时保持隐藏即可。',
        close: '收起',
        provider: '平台',
        model: '模型',
        add: '添加',
        remove: '移除',
        moveUp: '上移',
        moveDown: '下移',
        strategy: '策略',
        strategyValue: '顺序降级',
        memberUnavailable: '当前不可用（该平台未注册），巡回时跳过',
        threshold: '超时次数上限',
        thresholdHint: '同一个模型同一阶段超时超过该次数后，切换到下一个成员。',
        graceTitle: '短时限流原地重试',
        graceHint: '开启后，带「稍后重试」提示的 429 会先在当前模型上重试，而不是立刻切走。适合 WorkBuddy 这类自己会在账号间轮换的平台。多条配额用尽（QUOTA）始终直接切换。',
        graceOff: '关闭（限流立即切换）',
        graceOn: '开启（短时限流先原地重试）',
        graceWait: '最长等待',
        graceWaitHint: '平台给出的等待时间不超过该值时才原地重试；更长的等待直接切换。',
        graceAttempts: '原地重试次数',
        graceAttemptsHint: '同一模型最多原地重试这么多次，仍失败则标记停用并切到下一个成员。',
        ms: '毫秒',
        save: '保存组合',
        saving: '保存中…',
        cancel: '取消',
        reset: '重置状态',
        saved: '已保存',
        saveFailed: '保存失败',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        loading: '正在加载…',
        unsaved: '有未保存的改动',
        state: '当前状态',
        phase: '阶段',
        active: '当前模型',
        noActive: '（未接管）',
        phaseIdle: '空闲',
        phaseRound1: '第一轮巡回',
        phaseRetest: '重测超时模型',
        phaseFallback: 'DSH 平台兜底',
        dead: '限流停用',
        timeouts: '超时计数',
        log: '最近决策',
        noAgents: '当前没有活动会话。',
        platformTier: '兜底平台',
        catalog: '模型目录',
        catalogHint: '来自当前可用的 provider 与模型；仅第三方模型可加入组合。',
        refresh: '刷新目录',
        platformBadge: '平台',
        thirdBadge: '第三方',
        alreadyAdded: '已在组合中',
        none: '（无）',
        agent: '会话',
        timeoutUnit: '次',
        fallbackTitle: 'DSH 兜底模型',
        fallbackHint: '组合与重测都失败后，最后一个顶上的模型。默认自动选择本机可用的第一个平台模型。',
        fallbackAuto: '自动（第一个可用平台模型）',
        fallbackCurrent: '当前兜底',
        fallbackUnknown: '自动',
        fallbackSave: '设为兜底',
        fallbackNotPlatform: '只能选择 DSH 平台模型',
        fallbackNone: '本机没有可用的平台模型',
        savedCombos: '已存组合',
        savedCombosHint: '每个组合一张卡片；同一时间只有一个组合生效，可以随时切换或继续编辑。',
        noCombos: '还没有保存的组合。点「新建组合」开始。',
        newCombo: '新建组合',
        unnamed: '（未命名组合）',
        create: '创建',
        edit: '编辑',
        delete: '删除',
        activate: '设为生效',
        activeBadge: '生效中',
        comboUnusable: '组合内没有可用成员',
        members: '个成员',
        visionTitle: '「自动识图」是什么',
        visionWhat: '带「自动识图」的平台是同一后端的识图变体：模型列表相同，额外允许把图片作为输入。它不会改变模型的推理能力，只是多了一个图片入口。',
        visionCanSee: '视觉模型（能读图的，例如带 VL / Vision / 4o 等标记）：开启后可以直接把截图、图表、界面图发给它，让它读图作答。',
        visionCannotSee: '纯文本模型（只处理文字的）：开启或不开启都一样，模型本身没有视觉能力，图片会被忽略或直接被拒绝，选识图变体不会让它「看懂图」。',
        visionAdvice: '建议：日常纯文字任务用不带识图的那一条，上下文与费用更省；需要看截图、认图时，把同一平台的识图变体单独加一条排在后面，或临时切过去。不要把识图变体当成「更强」的模型重复塞进同一个组合。',
        visionInlineWarn: '组合里含「自动识图」成员：这类路线每次请求都会把会话历史里的图片全部内联（base64）发给上游，图片多的长会话可能直接报「Invalid string length」而失败。建议成员一律用不带识图的版本，识图交给识图插件按需分发。',
        visionWarnTitle: '识图成员提醒',
        pillTour: '自动组合',
        pillRetest: '重测中',
        pillFallback: '平台兜底',
        pillIndex: '第 {n} 个',
        pillHint: '当前这一轮实际在用的模型',
      },
      en: {
        'meta.title': 'Model Auto-Switch',
        'meta.description': 'Define an ordered combo of third-party models; on rate-limit or when timeouts exceed the limit it switches to the next model, retests timed-out models once the combo is exhausted, and finally falls back to the DSH platform model.',
        title: 'Model Auto-Switch',
        subtitle: 'An ordered combo: rate-limit switches immediately, timeouts above the limit switch too, timed-out models get one retest after the combo is exhausted, and the DSH platform model is the last resort.',
        enabled: 'Enabled',
        disabled: 'Disabled',
        rotation: 'Members (in order)',
        rotationHint: 'Tried in this order; earlier entries win. Metadata comes from the live model catalog.',
        empty: 'No members yet. Add at least one third-party model from the catalog below.',
        addMember: 'Add member',
        name: 'Name',
        namePlaceholder: 'e.g. free-first, paid-second',
        pickerTitle: 'Pick a model',
        search: 'Search',
        searchPlaceholder: 'Search model id or name',
        noMatch: 'No matching model',
        showVision: 'Show vision variants',
        visionHint: 'Entries marked with vision are the same provider with image input enabled; they list the same models. Keep them hidden unless you need images.',
        close: 'Close',
        provider: 'Provider',
        model: 'Model',
        add: 'Add',
        remove: 'Remove',
        moveUp: 'Move up',
        moveDown: 'Move down',
        strategy: 'Strategy',
        strategyValue: 'Sequential failover',
        memberUnavailable: 'Unavailable here (provider not registered) — skipped by the tour',
        threshold: 'Timeout limit',
        thresholdHint: 'After this many timeouts of one model in one phase, switch to the next member.',
        graceTitle: 'Retry short rate limits in place',
        graceHint: 'When on, a 429 that states a short wait is retried on the same model instead of switching away at once. Useful for providers like WorkBuddy that already rotate accounts behind one route. Quota exhaustion (QUOTA) always switches immediately.',
        graceOff: 'Off (switch on any rate limit)',
        graceOn: 'On (retry short limits in place first)',
        graceWait: 'Maximum wait',
        graceWaitHint: 'Only a stated wait at or below this value is retried in place; longer waits switch at once.',
        graceAttempts: 'In-place retries',
        graceAttemptsHint: 'How many times one model may be retried in place before it is marked dead and the tour moves on.',
        ms: 'ms',
        save: 'Save combo',
        saving: 'Saving…',
        cancel: 'Cancel',
        reset: 'Reset state',
        saved: 'Saved',
        saveFailed: 'Save failed',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        loading: 'Loading…',
        unsaved: 'Unsaved changes',
        state: 'Live state',
        phase: 'Phase',
        active: 'Active model',
        noActive: '(not taking over)',
        phaseIdle: 'Idle',
        phaseRound1: 'First tour',
        phaseRetest: 'Retesting timeouts',
        phaseFallback: 'DSH platform fallback',
        dead: 'Rate-limited',
        timeouts: 'Timeouts',
        log: 'Recent decisions',
        noAgents: 'No active session.',
        platformTier: 'Fallback platform',
        catalog: 'Model catalog',
        catalogHint: 'Providers and models available right now; only third-party models join the combo.',
        refresh: 'Refresh catalog',
        platformBadge: 'platform',
        thirdBadge: 'third-party',
        alreadyAdded: 'already added',
        none: '(none)',
        agent: 'Session',
        timeoutUnit: '',
        fallbackTitle: 'DSH fallback model',
        fallbackHint: 'The model used last, after the combo and its retest are exhausted. Defaults to the first platform model available on this machine.',
        fallbackAuto: 'Auto (first available platform model)',
        fallbackCurrent: 'Current fallback',
        fallbackUnknown: 'auto',
        fallbackSave: 'Set as fallback',
        fallbackNotPlatform: 'Only a DSH platform model can be chosen',
        fallbackNone: 'No platform model available here',
        savedCombos: 'Saved combos',
        savedCombosHint: 'One card per combo; exactly one is in force at a time, and you can switch or keep editing any of them.',
        noCombos: 'No saved combos yet. Press "New combo" to start one.',
        newCombo: 'New combo',
        unnamed: '(unnamed combo)',
        create: 'Create',
        edit: 'Edit',
        delete: 'Delete',
        activate: 'Make active',
        activeBadge: 'active',
        comboUnusable: 'No usable member',
        members: 'members',
        visionTitle: 'What "vision" means',
        visionWhat: 'A provider marked vision is the same backend with an extra image-input path; it lists the same models and does not change reasoning quality.',
        visionCanSee: 'Vision-capable models (marked VL / Vision / 4o etc.): with the vision variant enabled you can send screenshots, charts and UI images and the model can read them.',
        visionCannotSee: 'Text-only models: enabling the vision variant changes nothing — the model has no visual capability, so images are ignored or rejected. A vision variant does not make a text model see.',
        visionAdvice: 'Recommendation: use the plain (non-vision) entry for everyday text work to save context and cost; add the vision twin as a separate later member, or switch to it temporarily, only when you need to send images. Do not stack both twins as if one were "stronger".',
        visionInlineWarn: 'The combo contains a vision member: this route inlines EVERY image in the session history (base64) into each request, and image-heavy long sessions can die with "Invalid string length". Prefer plain members in combos and let a vision plugin dispatch images on demand.',
        visionWarnTitle: 'Vision member warning',
        pillTour: 'Auto combo',
        pillRetest: 'Retesting',
        pillFallback: 'Platform fallback',
        pillIndex: 'member {n}',
        pillHint: 'The model this turn is actually using',
      },
    }

    const CSS = `
.mas{--mas-accent:var(--dsw-alias-state-business-primary,var(--color-blue-500));display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);min-width:0}
.mas *{box-sizing:border-box}
.mas-head{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.mas-head-main{flex:1 1 320px;min-width:0}
.mas-title{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em}
.mas-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.mas-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px;min-width:0;display:flex;flex-direction:column;gap:10px}
.mas-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.mas-card-title{font-size:13px;font-weight:600}
.mas-card-sub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;overflow-wrap:anywhere;margin:0}
.mas-spacer{flex:1 1 auto}
.mas-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;transition:border-color .15s ease,background-color .15s ease}
.mas-btn:hover:enabled{border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.mas-btn:disabled{opacity:.45;cursor:default}
.mas-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--mas-accent));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.mas-btn-icon{width:26px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:11px}
.mas-rows{display:flex;flex-direction:column;gap:6px;min-width:0}
.mas-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:9px;padding:8px 10px;min-width:0}
.mas-row-idx{flex:none;width:20px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px}
.mas-row-main{flex:1 1 auto;min-width:0}
.mas-row-name{font-size:12.5px;font-weight:600;overflow-wrap:anywhere;word-break:break-word}
.mas-row-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px;margin-top:2px;overflow-wrap:anywhere}
.mas-row-actions{display:inline-flex;gap:4px;flex:none}
.mas-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mas-chip-on{border-color:color-mix(in srgb,var(--mas-accent) 45%,transparent);color:var(--mas-accent);background:color-mix(in srgb,var(--mas-accent) 8%,transparent)}
.mas-chip-warn{border-color:var(--dsw-alias-state-warning-border, #d9a544);color:var(--dsw-alias-state-warning-text, #a97400)}
.mas-row-off .mas-row-name,.mas-row-off .mas-row-meta{opacity:.55;text-decoration:line-through}
.mas-row-off .mas-row-name{text-decoration:none}
.mas-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:14px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.mas-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;min-width:0}
.mas-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 180px}
.mas-label{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.mas-select,.mas-input{font:inherit;font-size:12px;line-height:20px;padding:3px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);min-width:0;max-width:100%}
.mas-toggle{display:inline-flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;user-select:none}
.mas-toggle input{width:15px;height:15px;accent-color:var(--mas-accent);cursor:pointer}
.mas-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mas-note{color:var(--dsw-alias-label-secondary);font-size:11px}
.mas-vision-warn{color:var(--dsw-alias-state-warning,#b45309);font-size:11px;margin-top:6px;line-height:1.5}
.mas-combo.vision-warn{border-color:var(--dsw-alias-state-warning,#b45309)}
.mas-err{color:var(--dsw-alias-state-error-primary,var(--color-red-500));font-size:11.5px;overflow-wrap:anywhere}
.mas-ok{color:var(--dsw-alias-state-success-primary,var(--color-green-500));font-size:11.5px}
.mas-combos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:10px;min-width:0}
.mas-combo{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:11px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:7px;min-width:0}
.mas-combo-name{font-size:13px;font-weight:650;overflow-wrap:anywhere}
.mas-combo-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px}
.mas-combo-members{display:flex;flex-direction:column;gap:3px;min-width:0}
.mas-combo-member{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px}
.mas-combo-member-name{font-weight:600;overflow-wrap:anywhere}
.mas-combo-more{color:var(--dsw-alias-label-secondary);font-size:10.5px;padding-left:26px}
.mas-picker-wrap{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
.mas-vision-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px}
.mas-vision-list li{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mas-picker{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-1);max-height:420px;overflow:auto}
.mas-picker-list{display:flex;flex-direction:column;gap:10px}
.mas-picker-group{display:flex;flex-direction:column;gap:5px;min-width:0}
.mas-picker-caption{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.mas-picker-models{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr));gap:5px;min-width:0}
.mas-picker-model{font:inherit;text-align:left;font-size:11.5px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;display:flex;flex-direction:column;gap:2px;min-width:0}
.mas-picker-model:hover:enabled{border-color:var(--mas-accent);background:var(--dsw-alias-interactive-bg-hover)}
.mas-picker-model:disabled{opacity:.5;cursor:default}
.mas-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:8px;min-width:0}
.mas-group{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 10px;min-width:0;background:var(--dsw-alias-bg-layer-2)}
.mas-group-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;min-width:0}
.mas-group-name{font-size:12px;font-weight:600;overflow-wrap:anywhere}
.mas-models{display:flex;flex-direction:column;gap:2px}
.mas-model{font:inherit;text-align:left;font-size:11.5px;padding:2px 5px;border:0;border-radius:5px;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0}
.mas-model:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.mas-model:disabled{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:default}
.mas-model-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mas-model-id{color:var(--dsw-alias-label-secondary);font-size:10px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);overflow-wrap:anywhere}
.mas-agents{display:flex;flex-direction:column;gap:8px;min-width:0}
.mas-agent{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 10px;min-width:0;background:var(--dsw-alias-bg-layer-2)}
.mas-kv{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;align-items:baseline}
.mas-k{color:var(--dsw-alias-label-secondary);flex:none}
.mas-v{min-width:0;overflow-wrap:anywhere}
.mas-log{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.mas-log li{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}
.mas-pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;padding:2px 2px 0;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.mas-pill-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.mas-pill-dot-round1,.mas-pill-dot-retest{background:var(--mas-accent,var(--color-blue-500,#3b82f6))}
.mas-pill-dot-fallback{background:var(--dsw-alias-state-success,#22c55e)}
.mas-pill-phase{flex:none;color:var(--dsw-alias-label-secondary)}
.mas-pill-index{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.mas-pill-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10.5px}
.mas-pill-dead{flex:none;color:var(--dsw-alias-state-error,#ef4444);font-size:10px}
`

    /* ── transport ─────────────────────────────────────────────────────── */
    async function call(path, payload) {
      const response = await fetch(`${API}${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      })
      const text = await response.text()
      let data
      try { data = text === '' ? {} : JSON.parse(text) } catch { data = { ok: false, error: text } }
      return data
    }

    /** Model label for provider/model, falling back to the raw id. */
    function modelNameFor(groups, provider, model) {
      const group = (groups ?? []).find(g => g.provider === provider)
      const found = group ? (group.models ?? []).find(m => m.model === model) : undefined
      return found?.name ?? model
    }

    /* ── ambient pill: the model this session is really using ─────────── */
    /**
     * A combo member is never the wire model the composer names: the picker
     * holds the combo, while every attempt goes to whichever member the tour
     * is on. The host state machine already records that per agent and `agent`
     * there is the session id, so the pill filters by the session it was
     * registered for and shows the live route.
     *
     * It renders NOTHING unless the session is actually engaged with a combo.
     * A permanent badge on an ordinary session would be noise, and a chip that
     * outlived the tour would claim a model the next turn is not using.
     */
    function CurrentModelPill({ t, sessionId }) {
      const [row, setRow] = useState(undefined)
      useEffect(() => {
        let alive = true
        const read = async () => {
          try {
            const payload = await call('/state')
            if (!alive || payload?.ok !== true) return
            const needle = String(sessionId ?? '')
            setRow((payload.agents ?? []).find(a => String(a.agent) === needle))
          } catch { /* a poll miss must never break the composer */ }
        }
        void read()
        const timer = setInterval(read, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      if (!row || row.engaged !== true) return null
      const phase = row.phase === 'retest' ? t('pillRetest')
        : row.phase === 'fallback' ? t('pillFallback')
          : t('pillTour')
      const active = row.active ? String(row.active) : ''
      const rotation = Array.isArray(row.rotation) ? row.rotation : []
      const index = active === '' ? 0 : rotation.indexOf(active) + 1
      const dead = Array.isArray(row.dead) ? row.dead.length : 0
      return h('div', { className: 'mas-pill', title: t('pillHint') },
        h('span', { className: `mas-pill-dot mas-pill-dot-${String(row.phase ?? 'idle')}` }),
        h('span', { className: 'mas-pill-phase' }, phase),
        index > 0
          ? h('span', { className: 'mas-pill-index' }, t('pillIndex').replace('{n}', `${index}/${rotation.length}`))
          : null,
        h('span', { className: 'mas-pill-model' }, active || t('noActive')),
        dead > 0 ? h('span', { className: 'mas-pill-dead' }, `${t('dead')} ${dead}`) : null)
    }

    /* ── the page ──────────────────────────────────────────────────────── */
    function Page({ t }) {
      const [state, setState] = useState(undefined)
      const [catalog, setCatalog] = useState(undefined)
      const [error, setError] = useState('')
      // '' = showing the saved-combo cards, 'new' = creating one, otherwise the
      // id of the combo being edited.
      const [editingId, setEditingId] = useState('')
      const [draft, setDraft] = useState([])
      const [name, setName] = useState('')
      const [threshold, setThreshold] = useState(2)
      const [enabled, setEnabled] = useState(true)
      const [pickerOpen, setPickerOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [showVision, setShowVision] = useState(false)
      const [fallbackPick, setFallbackPick] = useState('')
      const [graceOn, setGraceOn] = useState(false)
      const [graceWait, setGraceWait] = useState(10000)
      const [graceAttempts, setGraceAttempts] = useState(2)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [saveError, setSaveError] = useState('')
      // A stable box, deliberately NOT React state: the background poll must not
      // re-render (or reset) the editor just because the user has pending edits.
      const [edits] = useState(() => ({ touched: false }))
      const markEdited = () => { edits.touched = true }

      const adopt = useCallback((payload, force) => {
        if (!payload || payload.ok !== true) {
          setError(payload?.error ?? t('loadFailed'))
          return false
        }
        setError('')
        setState(payload)
        // /state is polled every few seconds. Without this guard the poll pushed
        // the SAVED combo back into the editor while the user was still
        // assembling one — which looked like "added members vanish".
        if (force !== true && edits.touched) return true
        setEnabled(payload.enabled !== false)
        setGraceOn(payload.retryShortRateLimits === true)
        if (Number.isFinite(payload.shortRateLimitMs)) setGraceWait(payload.shortRateLimitMs)
        if (Number.isFinite(payload.graceAttempts)) setGraceAttempts(payload.graceAttempts)
        return true
      }, [t, edits])

      const reload = useCallback(async () => {
        adopt(await call('/state'), true)
      }, [adopt])

      const loadCatalog = useCallback(async () => {
        const payload = await call('/catalog')
        if (payload?.ok === true) setCatalog(payload)
        else setCatalog({ ok: false, groups: [], failures: [] })
      }, [])

      useEffect(() => {
        void reload()
        void loadCatalog()
      }, [reload, loadCatalog])

      // The combo list may change under us (another window, an agent tool call).
      useEffect(() => {
        const timer = setInterval(() => { void call('/state').then(adopt).catch(() => {}) }, 5000)
        return () => clearInterval(timer)
      }, [adopt])

      const groups = catalog?.groups ?? []
      const platformProviders = state?.platformProviders ?? catalog?.platformProviders ?? []
      const combos = state?.combos ?? []
      // Providers whose id/name carries the vision suffix ("+ 自动识图") are the
      // SAME backend with image input enabled, so they duplicate every model.
      // They are hidden by default so the catalog is not doubled.
      const isVisionGroup = useCallback(group => {
        const id = String(group.provider ?? '')
        const label = String(group.providerName ?? '')
        return /-vision$/.test(id) || /自动识图|\+\s*vision/i.test(label)
      }, [])
      const thirdParty = useMemo(
        () => groups.filter(g => g.platform !== true && (showVision || !isVisionGroup(g))),
        [groups, showVision, isVisionGroup],
      )
      const matcher = useCallback(term => {
        const needle = String(term ?? '').trim().toLowerCase()
        if (needle === '') return () => true
        return model => `${model.model} ${model.name}`.toLowerCase().includes(needle)
      }, [])
      const visibleThirdParty = useMemo(() => {
        const match = matcher(query)
        return thirdParty
          .map(group => ({ ...group, models: (group.models ?? []).filter(match) }))
          .filter(group => group.models.length > 0)
      }, [thirdParty, query, matcher])
      const matching = useMemo(
        () => visibleThirdParty.reduce((total, group) => total + group.models.length, 0),
        [visibleThirdParty],
      )

      // The DSH fallback tier: platform providers with their real models.
      const platformGroups = useMemo(
        () => groups.filter(g => g.platform === true && (g.models ?? []).length > 0),
        [groups],
      )
      const fallbackKey = state?.fallback
        ? `${state.fallback.provider}/${state.fallback.model}`
        : ''
      const fallbackLabel = state?.fallback
        ? `${modelNameFor(groups, state.fallback.provider, state.fallback.model)} · ${fallbackKey}`
        : t('fallbackUnknown')

      /** Human/model label for one route, from the live catalog. */
      const modelName = useCallback((provider, model) => {
        const group = (catalog?.groups ?? []).find(g => g.provider === provider)
        const found = group ? (group.models ?? []).find(m => m.model === model) : undefined
        return found?.name ?? model
      }, [catalog])

      const editing = editingId === 'new' || (editingId !== '' && combos.some(c => c.id === editingId))
      const editingCombo = combos.find(c => c.id === editingId)

      const startEdit = combo => {
        edits.touched = false
        setEditingId(combo.id)
        setDraft((combo.rotation ?? []).map(r => ({ provider: r.provider, model: r.model })))
        setName(combo.name ?? '')
        setThreshold(Number.isFinite(combo.timeoutThreshold) ? combo.timeoutThreshold : (state?.timeoutThreshold ?? 2))
        setSaveError('')
        setPickerOpen(false)
        setQuery('')
      }

      const startNew = () => {
        edits.touched = false
        setEditingId('new')
        setDraft([])
        setName('')
        setThreshold(state?.timeoutThreshold ?? 2)
        setSaveError('')
        setPickerOpen(true)
        setQuery('')
      }

      const stopEditing = () => {
        edits.touched = false
        setEditingId('')
        setSaveError('')
        setPickerOpen(false)
        setQuery('')
      }

      const dirty = useMemo(() => {
        if (!editing) return false
        if (editingId === 'new') return true
        if (!editingCombo) return true
        if (name !== (editingCombo.name ?? '')) return true
        if (threshold !== editingCombo.timeoutThreshold) return true
        const saved = editingCombo.rotation ?? []
        if (saved.length !== draft.length) return true
        return saved.some((r, i) => r.provider !== draft[i].provider || r.model !== draft[i].model)
      }, [editing, editingId, editingCombo, draft, name, threshold])

      const move = (index, delta) => {
        markEdited()
        setDraft(current => {
          const next = [...current]
          const to = index + delta
          if (to < 0 || to >= next.length) return current
          const [item] = next.splice(index, 1)
          next.splice(to, 0, item)
          return next
        })
      }

      const removeAt = index => {
        markEdited()
        setDraft(current => current.filter((_, i) => i !== index))
      }

      const addRoute = route => {
        markEdited()
        setDraft(current => {
          if (current.some(r => r.provider === route.provider && r.model === route.model)) return current
          return [...current, { provider: route.provider, model: route.model }]
        })
      }

      /** Save the combo being edited (creating it when editingId === 'new'). */
      const save = async () => {
        setSaving(true)
        setSaveError('')
        try {
          const combo = { name, rotation: draft, timeoutThreshold: threshold }
          if (editingId !== 'new') combo.id = editingId
          const payload = await call('/save', { combo, enabled })
          if (payload?.ok === true) {
            edits.touched = false
            // Adopt the response immediately: the saved card must show up right
            // away instead of waiting for the next poll.
            adopt(payload, true)
            setEditingId('')
            setPickerOpen(false)
            setNotice(t('saved'))
            setTimeout(() => setNotice(''), 2500)
          } else {
            setSaveError(payload?.error ?? t('saveFailed'))
          }
        } catch (cause) {
          setSaveError(String(cause?.message ?? cause))
        } finally {
          setSaving(false)
        }
      }

      const removeCombo = async id => {
        const payload = await call('/delete', { id })
        if (payload?.ok === true) {
          if (editingId === id) stopEditing()
          adopt(payload, true)
        }
      }

      const activateCombo = async id => {
        const payload = await call('/activate', { id })
        if (payload?.ok === true) adopt(payload, true)
      }

      const setEnabledFlag = async next => {
        setEnabled(next)
        const payload = await call('/save', { enabled: next })
        if (payload?.ok === true) adopt(payload, true)
      }

      const saveGrace = async patch => {
        const body = { ...patch }
        setSaveError('')
        const payload = await call('/save', body)
        if (payload?.ok === true) {
          adopt(payload, true)
          setNotice(t('saved'))
          setTimeout(() => setNotice(''), 2500)
        } else {
          setSaveError(payload?.error ?? t('saveFailed'))
        }
      }

      const saveFallback = async () => {
        if (fallbackPick === '') return
        const at = fallbackPick.indexOf('/')
        if (at <= 0) return
        const provider = fallbackPick.slice(0, at)
        const model = fallbackPick.slice(at + 1)
        setSaveError('')
        const payload = await call('/save', { fallback: { provider, model } })
        if (payload?.ok === true) {
          adopt(payload, true)
          setNotice(t('saved'))
          setTimeout(() => setNotice(''), 2500)
        } else {
          setSaveError(payload?.error ?? t('saveFailed'))
        }
      }

      const clearFallback = async () => {
        const payload = await call('/save', { fallback: null })
        if (payload?.ok === true) {
          setFallbackPick('')
          adopt(payload, true)
        }
      }

      const resetState = async () => {
        const payload = await call('/reset', {})
        if (payload?.ok === true) {
          edits.touched = false
          adopt(payload, true)
        }
      }

      /* ── loading / error ── */
      if (state === undefined) {
        return h('div', { className: 'mas' },
          h('div', { className: 'mas-card' },
            h('div', { className: 'mas-card-title' }, t('title')),
            h('p', { className: error === '' ? 'mas-card-sub' : 'mas-err' },
              error === '' ? t('loading') : `${t('loadFailed')} — ${error}`),
            error === ''
              ? null
              : h('div', { className: 'mas-foot' },
                  h('button', { className: 'mas-btn', type: 'button', onClick: () => { void reload() } }, t('retry')))))
      }

      const phaseLabel = state.agents?.[0]?.phase === 'round1' ? t('phaseRound1')
        : state.agents?.[0]?.phase === 'retest' ? t('phaseRetest')
          : state.agents?.[0]?.phase === 'fallback' ? t('phaseFallback')
            : t('phaseIdle')

      /* ── one saved combo card ── */
      const comboCard = combo => h('div', {
        className: (combo.rotation ?? []).some(r => /-vision$/i.test(String(r.provider ?? '')))
          ? 'mas-combo vision-warn'
          : 'mas-combo',
        key: combo.id,
      },
        h('div', { className: 'mas-card-head' },
          h('span', { className: 'mas-combo-name' }, combo.name !== '' ? combo.name : t('unnamed')),
          combo.active ? h('span', { className: 'mas-chip mas-chip-on' }, t('activeBadge')) : null,
          combo.usable === false ? h('span', { className: 'mas-chip mas-chip-warn' }, t('comboUnusable')) : null,
          h('span', { className: 'mas-spacer' }),
          h('span', { className: 'mas-chip' }, `${t('strategy')}: ${t('strategyValue')}`)),
        h('div', { className: 'mas-combo-meta' },
          `${combo.memberCount ?? 0} ${t('members')} · ${t('threshold')} ${combo.timeoutThreshold ?? threshold} ${t('timeoutUnit')}`),
        (combo.rotation ?? []).length === 0
          ? h('div', { className: 'mas-empty' }, t('empty'))
          : h('div', { className: 'mas-combo-members' },
              (combo.rotation ?? []).slice(0, 3).map((route, index) => h('div', {
                className: route.available === false ? 'mas-combo-member mas-row-off' : 'mas-combo-member',
                key: `${route.provider}/${route.model}/${index}`,
              },
                h('span', { className: 'mas-row-idx' }, String(index + 1)),
                h('span', { className: 'mas-combo-member-name' }, modelName(route.provider, route.model)),
                h('span', { className: 'mas-model-id' }, `${route.provider} · ${route.model}`))),
              (combo.rotation ?? []).length > 3
                ? h('div', { className: 'mas-combo-more' }, `+${(combo.rotation ?? []).length - 3}`)
                : null),
        h('div', { className: 'mas-foot' },
          combo.active
            ? null
            : h('button', { className: 'mas-btn', type: 'button', onClick: () => { void activateCombo(combo.id) } }, t('activate')),
          h('button', { className: 'mas-btn', type: 'button', onClick: () => startEdit(combo) }, t('edit')),
          h('button', { className: 'mas-btn', type: 'button', onClick: () => { void removeCombo(combo.id) } }, t('delete'))))

      /* ── the editor (name + ordered members + threshold) ── */
      const editor = h('div', { className: 'mas-card' },
        h('div', { className: 'mas-card-head' },
          h('span', { className: 'mas-card-title' }, editingId === 'new' ? t('newCombo') : t('rotation')),
          h('span', { className: 'mas-spacer' }),
          h('span', { className: 'mas-chip' }, `${t('strategy')}: ${t('strategyValue')}`),
          dirty ? h('span', { className: 'mas-chip mas-chip-on' }, t('unsaved')) : null),
        h('p', { className: 'mas-card-sub' }, t('rotationHint')),
        h('div', { className: 'mas-form' },
          h('div', { className: 'mas-field' },
            h('span', { className: 'mas-label' }, t('name')),
            h('input', {
              className: 'mas-input', type: 'text', value: name,
              placeholder: t('namePlaceholder'), maxLength: 120,
              onChange: event => { markEdited(); setName(event.target.value) },
            }))),
        draft.length === 0
          ? h('div', { className: 'mas-empty' }, t('empty'))
          : h('div', { className: 'mas-rows' },
              draft.map((route, index) => h('div', {
                className: route.available === false ? 'mas-row mas-row-off' : 'mas-row',
                key: `${route.provider}/${route.model}/${index}`,
              },
                h('span', { className: 'mas-row-idx' }, String(index + 1)),
                h('div', { className: 'mas-row-main' },
                  h('div', { className: 'mas-row-name' }, modelName(route.provider, route.model)),
                  h('div', { className: 'mas-row-meta' }, `${route.provider} · ${route.model}`)),
                h('span', { className: 'mas-row-actions' },
                  h('button', {
                    className: 'mas-btn mas-btn-icon', type: 'button',
                    title: t('moveUp'), 'aria-label': t('moveUp'),
                    disabled: index === 0, onClick: () => move(index, -1),
                  }, '↑'),
                  h('button', {
                    className: 'mas-btn mas-btn-icon', type: 'button',
                    title: t('moveDown'), 'aria-label': t('moveDown'),
                    disabled: index === draft.length - 1, onClick: () => move(index, 1),
                  }, '↓'),
                  h('button', { className: 'mas-btn', type: 'button', onClick: () => removeAt(index) }, t('remove')))))),
        draft.some(r => /-vision$/i.test(String(r.provider ?? '')))
          ? h('p', { className: 'mas-note mas-vision-warn' }, `⚠ ${t('visionWarnTitle')}: ${t('visionInlineWarn')}`)
          : null,
        h('div', { className: 'mas-foot' },
          h('span', { className: 'mas-label' }, t('threshold')),
          h('input', {
            className: 'mas-input', type: 'number', min: 0, step: 1, value: threshold,
            style: { width: '76px' },
            onChange: event => { markEdited(); setThreshold(Math.max(0, Math.trunc(Number(event.target.value) || 0))) },
          }),
          h('span', { className: 'mas-note' }, t('thresholdHint'))),
        /* add member → model picker */
        h('div', { className: 'mas-picker-wrap' },
          h('div', { className: 'mas-card-head' },
            h('span', { className: 'mas-card-title' }, t('addMember')),
            h('span', { className: 'mas-spacer' }),
            h('button', {
              className: 'mas-btn mas-btn-primary', type: 'button',
              onClick: () => { setPickerOpen(open => !open); void loadCatalog() },
            }, pickerOpen ? t('close') : t('pickerTitle'))),
          h('p', { className: 'mas-card-sub' }, t('catalogHint')),
          !pickerOpen ? null : h('div', { className: 'mas-picker' },
            h('div', { className: 'mas-form' },
              h('div', { className: 'mas-field', style: { flex: '3 1 240px' } },
                h('span', { className: 'mas-label' }, t('search')),
                h('input', {
                  className: 'mas-input', type: 'search', value: query,
                  placeholder: t('searchPlaceholder'),
                  onChange: event => setQuery(event.target.value),
                })),
              h('label', { className: 'mas-toggle', style: { alignSelf: 'flex-end', paddingBottom: '3px' } },
                h('input', {
                  type: 'checkbox', checked: showVision,
                  onChange: event => setShowVision(event.target.checked),
                }),
                h('span', null, t('showVision'))),
              h('button', {
                className: 'mas-btn', type: 'button', style: { alignSelf: 'flex-end' },
                onClick: () => { void loadCatalog() },
              }, t('refresh')))),
            showVision ? h('p', { className: 'mas-card-sub' }, t('visionHint')) : null,
            matching === 0
              ? h('div', { className: 'mas-empty' }, catalog === undefined ? t('loading') : t('noMatch'))
              : h('div', { className: 'mas-picker-list' },
                  visibleThirdParty.map(group => h('div', { className: 'mas-picker-group', key: group.provider },
                    h('div', { className: 'mas-picker-caption' },
                      h('span', { className: 'mas-group-name' }, group.providerName ?? group.provider),
                      h('span', { className: 'mas-model-id' }, group.provider)),
                    h('div', { className: 'mas-picker-models' },
                      (group.models ?? []).map(model => {
                        const added = draft.some(r => r.provider === group.provider && r.model === model.model)
                        return h('button', {
                          className: 'mas-picker-model', key: model.model, type: 'button',
                          disabled: added,
                          onClick: () => addRoute({ provider: group.provider, model: model.model }),
                        },
                          h('span', { className: 'mas-model-name' }, model.name),
                          h('span', { className: 'mas-model-id' }, model.model),
                          added ? h('span', { className: 'mas-chip mas-chip-on' }, '✓') : null)
                      })))))),
        h('div', { className: 'mas-foot' },
          h('button', {
            className: 'mas-btn mas-btn-primary', type: 'button',
            onClick: () => { void save() }, disabled: saving,
          }, saving ? t('saving') : t('save')),
          h('button', { className: 'mas-btn', type: 'button', onClick: stopEditing, disabled: saving }, t('cancel')),
          notice !== '' ? h('span', { className: 'mas-ok' }, notice) : null,
          saveError !== '' ? h('span', { className: 'mas-err' }, saveError) : null))

      /* ── the vision explainer ── */
      const visionNote = h('div', { className: 'mas-card' },
        h('div', { className: 'mas-card-head' },
          h('span', { className: 'mas-card-title' }, t('visionTitle'))),
        h('ul', { className: 'mas-vision-list' },
          h('li', null, t('visionWhat')),
          h('li', null, t('visionCanSee')),
          h('li', null, t('visionCannotSee'))),
        h('p', { className: 'mas-note' }, t('visionAdvice')))

      /* ── short rate limits: retry in place or switch at once ── */
      const graceCard = h('div', { className: 'mas-card' },
        h('div', { className: 'mas-card-head' },
          h('span', { className: 'mas-card-title' }, t('graceTitle')),
          h('span', { className: 'mas-spacer' }),
          h('label', { className: 'mas-toggle' },
            h('input', {
              type: 'checkbox', checked: graceOn,
              onChange: event => {
                const next = event.target.checked
                setGraceOn(next)
                void saveGrace({ retryShortRateLimits: next })
              },
            }),
            h('span', null, graceOn ? t('graceOn') : t('graceOff')))),
        h('p', { className: 'mas-card-sub' }, t('graceHint')),
        graceOn
          ? h('div', { className: 'mas-form' },
              h('div', { className: 'mas-field', style: { flex: '1 1 160px' } },
                h('span', { className: 'mas-label' }, `${t('graceWait')} (${t('ms')})`),
                h('input', {
                  className: 'mas-input', type: 'number', min: 0, step: 1000, value: graceWait,
                  onChange: event => {
                    const next = Number(event.target.value)
                    setGraceWait(Number.isFinite(next) ? next : 0)
                    markEdited()
                  },
                })),
              h('div', { className: 'mas-field', style: { flex: '1 1 160px' } },
                h('span', { className: 'mas-label' }, t('graceAttempts')),
                h('input', {
                  className: 'mas-input', type: 'number', min: 0, step: 1, value: graceAttempts,
                  onChange: event => {
                    const next = Number(event.target.value)
                    setGraceAttempts(Number.isFinite(next) ? next : 0)
                    markEdited()
                  },
                })),
              h('button', {
                className: 'mas-btn mas-btn-primary', type: 'button',
                style: { alignSelf: 'flex-end' },
                onClick: () => { void saveGrace({ shortRateLimitMs: graceWait, graceAttempts }) },
              }, t('save')))
          : null,
        graceOn ? h('span', { className: 'mas-note' }, t('graceWaitHint')) : null)

      return h('div', { className: 'mas' },
        /* header */
        h('div', { className: 'mas-head' },
          h('div', { className: 'mas-head-main' },
            h('h2', { className: 'mas-title' }, t('title')),
            h('p', { className: 'mas-sub' }, t('subtitle'))),
          h('label', { className: 'mas-toggle' },
            h('input', {
              type: 'checkbox', checked: enabled,
              onChange: event => { void setEnabledFlag(event.target.checked) },
            }),
            h('span', null, enabled ? t('enabled') : t('disabled')))),

        /* saved combos, one card each */
        editing ? null : h('div', { className: 'mas-card' },
          h('div', { className: 'mas-card-head' },
            h('span', { className: 'mas-card-title' }, t('savedCombos')),
            h('span', { className: 'mas-spacer' }),
            h('button', { className: 'mas-btn mas-btn-primary', type: 'button', onClick: startNew }, t('newCombo'))),
          h('p', { className: 'mas-card-sub' }, t('savedCombosHint')),
          combos.length === 0
            ? h('div', { className: 'mas-empty' }, t('noCombos'))
            : h('div', { className: 'mas-combos' }, combos.map(comboCard))),

        editing ? editor : null,

        /* DSH fallback tier: which platform model catches the last request */
        h('div', { className: 'mas-card' },
          h('div', { className: 'mas-card-head' },
            h('span', { className: 'mas-card-title' }, t('fallbackTitle')),
            h('span', { className: 'mas-spacer' }),
            h('span', { className: 'mas-chip' },
              `${t('fallbackCurrent')}: ${fallbackLabel}`)),
          h('p', { className: 'mas-card-sub' }, t('fallbackHint')),
          platformGroups.length === 0
            ? h('div', { className: 'mas-empty' }, t('fallbackNone'))
            : h('div', { className: 'mas-form' },
                h('div', { className: 'mas-field', style: { flex: '3 1 260px' } },
                  h('span', { className: 'mas-label' }, t('model')),
                  h('select', {
                    className: 'mas-select',
                    value: fallbackPick,
                    onChange: event => setFallbackPick(event.target.value),
                  },
                    h('option', { value: '' }, t('fallbackAuto')),
                    platformGroups.flatMap(group => (group.models ?? []).map(model => h('option', {
                      key: `${group.provider}/${model.model}`,
                      value: `${group.provider}/${model.model}`,
                    }, `${model.name} · ${group.provider}/${model.model}`))))),
                h('button', {
                  className: 'mas-btn mas-btn-primary', type: 'button',
                  style: { alignSelf: 'flex-end' },
                  disabled: fallbackPick === '',
                  onClick: () => { void saveFallback() },
                }, t('fallbackSave')),
                state?.fallback
                  ? h('button', {
                      className: 'mas-btn', type: 'button', style: { alignSelf: 'flex-end' },
                      onClick: () => { void clearFallback() },
                    }, t('fallbackAuto'))
                  : null),
          (state?.fallback && platformGroups.length > 0
            && !platformGroups.some(g => g.provider === state.fallback.provider))
            ? h('p', { className: 'mas-err' }, t('fallbackNotPlatform'))
            : null),
        graceCard,
        visionNote,

        /* live state */
        h('div', { className: 'mas-card' },
          h('div', { className: 'mas-card-head' },
            h('span', { className: 'mas-card-title' }, t('state')),
            h('span', { className: 'mas-spacer' }),
            h('span', { className: 'mas-chip' }, `${t('platformTier')}: ${platformProviders.join(', ') || t('none')}`),
            h('span', { className: 'mas-chip' }, `${t('phase')}: ${phaseLabel}`),
            h('button', {
              className: 'mas-btn', type: 'button', onClick: () => { void resetState() },
            }, t('reset'))),
          (state.agents ?? []).length === 0
            ? h('p', { className: 'mas-card-sub' }, t('noAgents'))
            : h('div', { className: 'mas-agents' },
                (state.agents ?? []).map(agent => h('div', { className: 'mas-agent', key: agent.agent },
                  h('div', { className: 'mas-kv' },
                    h('span', { className: 'mas-k' }, `${t('agent')}:`),
                    h('span', { className: 'mas-v' }, String(agent.agent))),
                  h('div', { className: 'mas-kv' },
                    h('span', { className: 'mas-k' }, `${t('active')}:`),
                    h('span', { className: 'mas-v' }, agent.active ?? t('noActive'))),
                  h('div', { className: 'mas-kv' },
                    h('span', { className: 'mas-k' }, `${t('timeouts')}:`),
                    h('span', { className: 'mas-v' },
                      Object.entries(agent.timeouts ?? {}).map(([key, count]) => `${key} ×${count}`).join('  ') || t('none'))),
                  h('div', { className: 'mas-kv' },
                    h('span', { className: 'mas-k' }, `${t('dead')}:`),
                    h('span', { className: 'mas-v' }, (agent.dead ?? []).join(', ') || t('none'))),
                  (agent.log ?? []).length === 0
                    ? null
                    : h(Fragment, null,
                        h('div', { className: 'mas-label', style: { marginTop: '6px' } }, t('log')),
                        h('ul', { className: 'mas-log' },
                          (agent.log ?? []).slice(-6).map((line, index) => h('li', { key: index }, line)))))))))
    }

    /* ── registration ──────────────────────────────────────────────────── */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        if (typeof value === 'string' && value !== '') return value
      } catch { /* fall through */ }
      const lang = typeof document !== 'undefined' ? document.documentElement.lang : ''
      return typeof lang === 'string' && lang !== '' ? lang : 'en'
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        // A re-mount after a client reload re-registers the same namespace;
        // the locale service rejects a duplicate locale, and the stale
        // dictionary is already correct, so loading twice must not throw.
        try {
          return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en })
        } catch {
          return () => {}
        }
      }, 'model-auto-switch: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'model-auto-switch')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-auto-switch: styles')

      // Side bar → Settings → 模型自动切换
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-auto-switch',
        order: 36,
        label: () => t('title'),
        locale: NS,
      }, props => h(Page, { ...props, t, locale: localeTag(ctx) })))

      // Plugins page → this bundle's card (that is the page the plugin list opens).
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-model-rotation',
      }, props => (props && props.view === 'summary')
        ? t('subtitle')
        : h(Page, { ...props, t, locale: localeTag(ctx) })))

      // Older/lower entry point: the row itself.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-model-rotation#model-auto-switch',
      }, props => (props && props.view === 'summary')
        ? t('subtitle')
        : h(Page, { ...props, t, locale: localeTag(ctx) })))

      // Ambient pill under the composer: which member the tour is on right now.
      // A free list seat, so it sits beside the shipped pills instead of
      // replacing any of them; `inject` hands us the session id the row is for,
      // and the component renders nothing while that session is not engaged.
      try {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'model-auto-switch-current',
          order: 40,
          locale: NS,
          inject: sessionId => ({ t, sessionId }),
        }, CurrentModelPill))
      } catch (cause) {
        // A slot failure must never take the host provider down with it.
        console.error('[model-auto-switch] composer pill failed to register:', cause)
      }
    }

    exports.inject = inject
    exports.apply = apply
    exports.name = 'model-auto-switch'
    exports.__test = { DICT, Page, call, CurrentModelPill }
    return module.exports
  },
})
