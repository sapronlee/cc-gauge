import { expect, mock, test } from 'claude-code/testing'

import { bar, desktopBand, detectStyle, forecast, limitColor, WARN, fmtLeft, fmtTokens, hitRate, layout, to256, width } from '../hooks/register'
import type { Measure, TurnTokens } from '../types'

// 桌面端每组一张图；拼起来便于整体断言
const svgOf = (...a: Parameters<typeof desktopBand>) => desktopBand(...a).map(p => p.svg).join('')

const BAND = {
  component: 'AbovePrompt',
  // The mount fills scroll and view; the band reads none of them
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } as never,
} as const

// 终端的带子画在输入框下方（PromptHint）。那里没有 bodyColumns，
// 宽度是从 viewport 推的，所以挂载时要给 viewport。
const HINT = {
  component: 'PromptHint',
  viewport: { columns: 144, rows: 40 },
  props: { hasSurvey: false, isWorking: false, isDraft: false, hint: '' } as never,
} as const

test('formats tokens, countdowns and hit rate', async () => {
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(15_600)).toBe('15.6K')
  expect(fmtTokens(100_000)).toBe('100K')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtLeft((2 * 60 + 40) * 60_000)).toBe('2h40m')
  expect(fmtLeft((31 * 60) * 60_000)).toBe('1d7h')
  expect(hitRate({ input: 50, output: 10, cacheRead: 900, cacheWrite: 50 })).toBe(90)
  expect(hitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(null)
})

test('band shows limits, context and the last turn on terminal and desktop', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  // 引擎自己在这块位置不画东西
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))

  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20 },
      { kind: 'seven_day', percentUsed: 58 },
    ],
    changed: ['context', 'rateLimits'],
  })
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 50,
      output_tokens: 3_000,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
  })

  const desk = await $.ui.mount({ plugin: 'cc-gauge', surface: 'desktop', ...BAND })
  // 每组一张图，仍画成纯图片（交互式 SVG 每次重绘都会闪）；整行两端对齐，不画分隔线
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.map(s => s.props.alt)).toEqual([
    '5-hour limit 20% used',
    '7-day limit 58% used',
    'context 100K of 1M',
    'cache hit 90%',
  ])
  for (const s of svgs) expect(s.props.isInteractive).toBeFalsy()
  const source = svgs.map(s => String(s.props.source)).join('')
  expect(source).toContain('<animate')
  expect(source).not.toContain('class="sep"')
  // 悬停卡片里的字只在卡片里，带子本身不画文字
  expect((await desk.findAll({ type: 'Text' })).map(x => x.text)).toEqual([
    '5 小时额度', '已用 20%',
    '7 天额度', '已用 58%',
    '上下文窗口', '已用 100K / 1M（10%）',
    '缓存命中率', '上一轮 90%：读缓存 900 / 总输入 1K',
  ])
  await desk.unmount()

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'cc-gauge', surface, ...HINT })
    expect(await ui.find({ type: 'Text', text: /^20%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^58%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/1M' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↑' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'not drawn' })).toBeUndefined()
    await ui.unmount()
  }
})

test('layout steps down to fit narrow terminals', async () => {
  const m = {
    context: { tokens: 130_000, window: 1_000_000, percent: 13 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(160 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(31 * 3_600_000).toISOString() },
    ],
  }
  const t = { input: 1_200, output: 3_000, cacheRead: 1_400_000, cacheWrite: 12_000 }
  expect(width(layout(m, t, 0, 0))).toBeLessThan(80)
})

test('the bar highlight moves left to right and keeps the bar width', async () => {
  const at = (f: number) => bar(50, 8, '#5cc4d6', f)
  const lum = (hex = '#000000') => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0)
  // 50% of 8 cells fills 4; frames 4..12 put the glow past the fill, so frame 7 has none
  const plain = at(7).map(s => lum(s.color))
  // The glow sits one cell further right each frame
  const glowAt = (f: number) => {
    const lift = at(f).map((s, i) => lum(s.color) - plain[i]!)
    return lift.indexOf(Math.max(...lift))
  }
  expect(glowAt(0)).toBe(0)
  expect(glowAt(2)).toBe(2)
  expect(glowAt(3)).toBe(3)
  // Gradient: without a glow the bar brightens left to right
  expect(plain[0]! < plain[3]!).toBe(true)
  for (const f of [0, 3, 7, 20]) expect(width(at(f))).toBe(8)
})

test('auto picks Nerd Font icons only in Ghostty; a manual setting wins', async () => {
  expect(detectStyle('auto', 'ghostty')).toBe('nerd')
  expect(detectStyle('auto', 'Apple_Terminal')).toBe('unicode')
  expect(detectStyle('auto', 'WarpTerminal')).toBe('unicode')
  expect(detectStyle('auto', undefined)).toBe('unicode')
  expect(detectStyle('nerd', 'Apple_Terminal')).toBe('nerd')
  expect(detectStyle('ascii', 'ghostty')).toBe('ascii')
})

test('256-color preview snaps colors to the xterm palette', async () => {
  expect(to256('#000000')).toBe('#000000')
  expect(to256('#ffffff')).toBe('#ffffff')
  expect(to256('#5cc4d6')).toBe('#5fd7d7')
})

test('preview command draws every terminal profile', async ($, on) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  const ui = await $.ui.mount({
    plugin: 'cc-gauge',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'cc-gauge-preview', args: '', text: '' },
  } as never)
  expect(await ui.find({ type: 'Text', text: 'Ghostty' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ascii fallback' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hit ' })).toBeDefined()
  await ui.unmount()
})

test('bars of different fill keep their highlights in step', async () => {
  const lum = (hex = '#000000') => [1, 3, 5].reduce((n, i) => n + parseInt(hex.slice(i, i + 2), 16), 0)
  const glowAt = (pct: number, f: number) => {
    const plain = bar(pct, 8, '#5cc4d6', 12).map(s => lum(s.color))
    const lift = bar(pct, 8, '#5cc4d6', f).map((s, i) => lum(s.color) - plain[i]!)
    return lift.indexOf(Math.max(...lift))
  }
  for (const f of [0, 1, 2, 3, 13, 15]) expect(glowAt(50, f)).toBe(glowAt(90, f))
})

test('desktop context is a 2×10 dot matrix, top row first', async () => {
  const svgFor = (pct: number) =>
    svgOf({ context: { tokens: pct * 10_000, window: 1_000_000, percent: pct }, rateLimits: [] }, null, 0)
  const lit = (svg: string) => (svg.match(/<clipPath id="c-ctx">(.*?)<\/clipPath>/)?.[1]?.match(/<circle/g) ?? []).length
  const all = (svg: string) => (svg.match(/<circle [^>]*r="1.6"/g) ?? []).length
  expect(all(svgFor(35))).toBe(20 + 7)
  expect(lit(svgFor(35))).toBe(7)
  expect(lit(svgFor(0))).toBe(0)
  expect(lit(svgFor(100))).toBe(20)
  // 60% fills the whole top row and two dots of the bottom one
  const rows = (svgFor(60).match(/<clipPath id="c-ctx">(.*?)<\/clipPath>/)?.[1] ?? '').match(/cy="[\d.]+"/g) ?? []
  expect(rows.filter(r => r === 'cy="11.35"').length).toBe(10)
  expect(rows.filter(r => r === 'cy="18.15"').length).toBe(2)
})

test('the terminal bar animates once the band is drawn', async ($, on) => {
  const clock = mock.clock(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 50 }],
    changed: ['context', 'rateLimits'],
  })
  const ui = await $.ui.mount({ plugin: 'cc-gauge', surface: 'terminal', ...HINT })
  const firstCell = async () => (await ui.find({ type: 'Text', text: '■' }))?.props.color
  const before = await firstCell()
  await clock.advance(200)
  expect(await firstCell()).not.toBe(before)
  await ui.unmount()
})

test('the desktop SVG declares both color schemes so a dark app gets no white backdrop', async () => {
  const svg = svgOf({ context: { tokens: 1, window: 10, percent: 10 }, rateLimits: [] }, null, 0)
  expect(svg).toContain('color-scheme:light dark')
  expect(svg).toContain('prefers-color-scheme:dark')
})


test('the desktop SVG is cropped to 18px so the band matches the branch bar', async () => {
  expect(svgOf({ context: { tokens: 1, window: 10, percent: 10 }, rateLimits: [] }, null, 0)).toMatch(
    /height="18" viewBox="0 6 \d+ 18"/,
  )
})

test('each desktop group carries a hover card', async () => {
  const at = Date.parse('2026-10-03T12:00:00Z')
  const m: Measure = {
    context: { tokens: 787_000, window: 1_000_000, percent: 79 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 5, resetsAt: new Date(at + 4 * 3_600_000 + 15 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 39, resetsAt: new Date(at + (2 * 24 + 23) * 3_600_000).toISOString() },
    ],
  }
  const t: TurnTokens = { input: 900, output: 2_000, cacheRead: 170_000, cacheWrite: 1_000 }
  expect(desktopBand(m, t, at).map(p => [p.title, p.detail])).toEqual([
    ['5 小时额度', '已用 5%，4h15m 后重置'],
    ['7 天额度', '已用 39%，2d23h 后重置'],
    ['上下文窗口', '已用 787K / 1M（79%）'],
    ['缓存命中率', '上一轮 99%：读缓存 170K / 总输入 172K'],
  ])
})

test('forecast extrapolates the window average pace', async () => {
  const at = Date.parse('2026-10-03T12:00:00Z')
  // 5h 窗口过去 3h、还剩 2h
  const five = (pct: number) => ({ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(at + 2 * 3_600_000).toISOString() })
  // 75% / 3h = 25%/h，剩下 25% 只要 1h，早于 2h 后的重置
  expect(forecast(five(75), at)).toEqual({ text: '按平均速度约 1h0m 后用满，早于重置', early: true })
  // 30% / 3h = 10%/h，重置时约到 50%
  expect(forecast(five(30), at)).toEqual({ text: '按平均速度，重置时约用到 50%', early: false })
  // 一点没用、已经用满、没有重置时间：都不预测
  expect(forecast(five(0), at)).toBeNull()
  expect(forecast(five(100), at)).toBeNull()
  expect(forecast({ kind: 'five_hour', percentUsed: 30 }, at)).toBeNull()
  // 窗口才过去不到一成（5h 的前 30 分钟），样本太少，不预测
  const fresh = { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(at + 4.75 * 3_600_000).toISOString() }
  expect(forecast(fresh, at)).toBeNull()
  // 7d 同理：过去 2 天用了 50%，按这速度 2 天后用满，早于 5 天后的重置
  const seven = { kind: 'seven_day', percentUsed: 50, resetsAt: new Date(at + 5 * 86_400_000).toISOString() }
  expect(forecast(seven, at)?.early).toBe(true)
})

test('a limit on pace to run out early turns yellow; 80% and up stays red', async () => {
  const at = Date.parse('2026-10-03T12:00:00Z')
  const resetsAt = new Date(at + 2 * 3_600_000).toISOString()
  expect(limitColor({ kind: 'five_hour', percentUsed: 30, resetsAt }, at, '#5cc4d6')).toBe('#5cc4d6')
  expect(limitColor({ kind: 'five_hour', percentUsed: 75, resetsAt }, at, '#5cc4d6')).toBe(WARN)
  expect(limitColor({ kind: 'five_hour', percentUsed: 85, resetsAt }, at, '#5cc4d6')).toBe('#e5685f')
  // 终端那条也跟着变色
  const m: Measure = { context: { tokens: 1, window: 10, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 75, resetsAt }] }
  expect(layout(m, null, at, 1).find(s => s.text === '75%')?.color).toBe(WARN)
})

test('the limit card adds the forecast as a third line', async () => {
  const at = Date.parse('2026-10-03T12:00:00Z')
  const m: Measure = {
    context: { tokens: 1, window: 10, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 75, resetsAt: new Date(at + 2 * 3_600_000).toISOString() }],
  }
  expect(desktopBand(m, null, at)[0]?.forecast).toEqual({ text: '按平均速度约 1h0m 后用满，早于重置', early: true })
  expect(desktopBand(m, null, at)[1]?.forecast).toBeUndefined()
})

test('a redraw that changes nothing visible is not written', async ($, on) => {
  const at = Date.parse('2026-10-03T12:00:00Z')
  const m: Measure = {
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    // 窗口才过去 10 分钟，还不出预测（预测的百分比随时间连续变化，变了就该重绘）
    rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: new Date(at + 4 * 3_600_000 + 50 * 60_000).toISOString() }],
  }
  // 4h50m and 4h50m less 20 seconds both read 4h50m; 100,040 tokens still reads 100K
  expect(desktopBand(m, null, at)).toEqual(desktopBand(m, null, at + 20_000))
  expect(desktopBand(m, null, at)).toEqual(desktopBand({ ...m, context: { ...m.context, tokens: 100_040 } }, null, at))
})

test('桌面端：同一位置内层插件画的内容接在用量带上面，不被挡住', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // 内层（别的插件或引擎）画了一行
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['内层内容'] }))
  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20 }],
    changed: ['context', 'rateLimits'],
  })
  const desk = await $.ui.mount({ plugin: 'cc-gauge', surface: 'desktop', ...BAND })
  const stack: any = await desk.find({ key: 'stack' })
  expect(stack).toMatchObject({ type: 'Box', props: { flexDirection: 'column', alignItems: 'stretch' } })
  // 引擎节点不能放在设了 width 的 Box 下：包着内层内容的 stack、inner 都不设宽度
  expect(stack.props.width).toBeUndefined()
  expect(((await desk.find({ key: 'inner' })) as any).props.width).toBeUndefined()
  const inner = await desk.find({ key: 'inner' })
  const usage = await desk.find({ key: 'usage' })
  expect(JSON.stringify(inner)).toContain('内层内容')
  expect(JSON.stringify(usage)).toContain('5-hour limit 20% used')
  // 内层画了东西：两块之间有分隔线
  expect(await desk.find({ key: 'divider' })).toMatchObject({ type: 'Box', props: { overflow: 'hidden' } })
  await desk.unmount()
})

test('桌面端：内层只有引擎的空节点时不画分隔线', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20 }],
    changed: ['context', 'rateLimits'],
  })
  const desk = await $.ui.mount({ plugin: 'cc-gauge', surface: 'desktop', ...BAND })
  expect(await desk.find({ key: 'divider' })).toBeUndefined()
  await desk.unmount()
})
