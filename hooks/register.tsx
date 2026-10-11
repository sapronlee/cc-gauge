import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Measure, Style, TurnTokens } from '../types'

const measure = atom({ plugin: 'cc-gauge', key: 'measure' } as const, null)
const turn = atom({ plugin: 'cc-gauge', key: 'turn' } as const, null)
const now = atom({ plugin: 'cc-gauge', key: 'now' } as const, 0)
const phase = atom({ plugin: 'cc-gauge', key: 'phase' } as const, 0)
const style = atom({ plugin: 'cc-gauge', key: 'style' } as const, 'unicode')

// One hue per metric; RED takes over only when a metric is in trouble
const HUE = { five: '#5cc4d6', seven: '#e8a25f', ctx: '#9aa5f5', cache: '#72cf9f' }
const RED = '#e5685f'
// 黄色：按目前速度会在重置前用满
export const WARN = '#e8d25a'
const TRACK = '#4a4f5c'
const FRAME_MS = 200
const PREVIEW = 'cc-gauge-preview'

export const GLYPHS: Record<Style, { ctx: string; hit: string; fill: string; track: string }> = {
  nerd: { ctx: '\u{F0328} ', hit: '\u{F04FE} ', fill: '■', track: '■' },
  unicode: { ctx: '≡ ', hit: '● ', fill: '■', track: '■' },
  ascii: { ctx: 'ctx ', hit: 'hit ', fill: '#', track: '-' },
}

// Terminals known to ship Nerd Font symbols without the user installing a font
const NERD_BUILTIN = new Set(['ghostty'])

export const detectStyle = (setting: string, termProgram: string | undefined): Style => {
  if (setting === 'nerd' || setting === 'unicode' || setting === 'ascii') return setting
  return NERD_BUILTIN.has((termProgram ?? '').toLowerCase()) ? 'nerd' : 'unicode'
}

export const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}

export const fmtLeft = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export const hitRate = (t: TurnTokens): number | null => {
  const total = t.input + t.cacheRead + t.cacheWrite
  return total === 0 ? null : Math.round((t.cacheRead / total) * 100)
}

const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

export type Forecast = { text: string; early: boolean }

// 用本窗口至今的平均速度外推（窗口起点 = 重置时间 − 窗口长度），不需要攒历史样本。
// 窗口过去不到一成时样本太少，一次突发就会误报，不预测
export const forecast = (l: Limit, at: number): Forecast | null => {
  const span = WINDOW_MS[l.kind]
  if (!span || !l.resetsAt || l.percentUsed <= 0 || l.percentUsed >= 100) return null
  const reset = Date.parse(l.resetsAt)
  const elapsed = at - (reset - span)
  const left = reset - at
  if (elapsed < span * 0.1 || left <= 0) return null
  const rate = l.percentUsed / elapsed
  const toFull = (100 - l.percentUsed) / rate
  if (toFull < left) return { text: `按平均速度约 ${fmtLeft(toFull)} 后用满，早于重置`, early: true }
  return { text: `按平均速度，重置时约用到 ${Math.round(l.percentUsed + rate * left)}%`, early: false }
}

// 80% 以上红色优先；否则会提前用满的转黄
export const limitColor = (l: Limit, at: number, hue: string) =>
  Math.round(l.percentUsed) >= 80 ? RED : forecast(l, at)?.early ? WARN : hue

// Blend a #rrggbb color toward white (t > 0) or black (t < 0) by |t|
export const lighten = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const target = t >= 0 ? 255 : 0
  const ch = (v: number) => Math.round(v + (target - v) * Math.abs(t)).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

// Nearest xterm-256 color, to preview how a 256-color terminal shows the band
export const to256 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const levels = [0, 95, 135, 175, 215, 255]
  const nearest = (v: number) => levels.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
  const cube = rgb.map(nearest)
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const g = Math.min(238, Math.max(8, 8 + Math.round((avg - 8) / 10) * 10))
  const dist = (c: readonly number[]) => c.reduce((s, v, i) => s + (v - rgb[i]!) ** 2, 0)
  const pick = dist(cube) <= dist([g, g, g]) ? cube : [g, g, g]
  return `#${pick.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

export type Span = { text: string; color?: string; dim?: boolean }
export type Look = { style: Style; colors: 'true' | '256' }

const SEP: Span = { text: '  ' }

export const width = (spans: Span[]) => spans.reduce((n, s) => n + [...s.text].length, 0)

// A bar whose filled part runs from a deep shade of its color to a bright one,
// with a soft highlight sweeping left to right on top
export const bar = (pct: number, cells: number, color: string, frame: number, s: Style = 'unicode'): Span[] => {
  const g = GLYPHS[s]
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round((pct / 100) * cells)))
  // Same period for every bar, so all highlights travel in step
  const pos = frame % (cells + 5)
  const spans: Span[] = []
  for (let i = 0; i < filled; i++) {
    const shade = filled === 1 ? 0 : -0.15 + (0.35 * i) / (filled - 1)
    const glow = i === pos ? 0.55 : i === pos - 1 || i === pos + 1 ? 0.25 : 0
    spans.push({ text: g.fill, color: lighten(lighten(color, shade), glow) })
  }
  if (cells > filled) spans.push({ text: g.track.repeat(cells - filled), color: TRACK })
  return spans
}

// detail 2: bars + countdowns; 1: no bars; 0: bare numbers
export const layout = (
  m: Measure | null,
  t: TurnTokens | null,
  at: number,
  detail: 0 | 1 | 2,
  frame = 0,
  look: Look = { style: 'unicode', colors: 'true' },
): Span[] => {
  const g = GLYPHS[look.style]
  const groups: Span[][] = []

  const limit = (label: string, l: Limit | undefined, hue: string) => {
    if (!l) return
    const pct = Math.round(l.percentUsed)
    const color = limitColor(l, at, hue)
    const out: Span[] = [{ text: `${label} `, color }]
    if (detail === 2) out.push(...bar(pct, 8, color, frame, look.style), { text: ' ' })
    out.push({ text: `${pct}%`, color })
    if (detail >= 1 && l.resetsAt) out.push({ text: ` · ${fmtLeft(Date.parse(l.resetsAt) - at)}`, dim: true })
    groups.push(out)
  }
  limit('5h', m?.rateLimits.find(l => l.kind === 'five_hour'), HUE.five)
  limit('7d', m?.rateLimits.find(l => l.kind === 'seven_day'), HUE.seven)

  if (m) {
    const pct = m.context.percent ?? 0
    const color = pct >= 80 ? RED : HUE.ctx
    groups.push([
      { text: g.ctx, color },
      { text: fmtTokens(m.context.tokens ?? 0), color },
      { text: `/${fmtTokens(m.context.window)}`, dim: true },
    ])
  }

  const hit = t ? hitRate(t) : null
  if (hit !== null) {
    const color = hit < 50 ? RED : HUE.cache
    groups.push([
      { text: g.hit, color },
      { text: `${hit}%`, color },
    ])
  }

  const spans = groups.flatMap((grp, i) => (i === 0 ? grp : [SEP, ...grp]))
  return look.colors === '256' ? spans.map(s => (s.color ? { ...s, color: to256(s.color) } : s)) : spans
}

const fit = (m: Measure | null, t: TurnTokens | null, at: number, cols: number, frame: number, look: Look) =>
  ([2, 1, 0] as const).map(d => layout(m, t, at, d, frame, look)).find(s => width(s) <= cols) ??
  layout(m, t, at, 0, frame, look)


// ---- Desktop: each group is an SVG drawn as a plain image. The SMIL shine runs in an image too,
// and an image redraws in place, where an interactive (framed) SVG reloads its frame and blinks
// the whole band on every redraw. 悬停说明用桌面端自带的悬浮卡片，不靠 SVG 的 <title>。

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// CAP: the band the figures' cap height occupies (Inter 13px on baseline 19.5);
// icons, dots and the inner rule are sized to it so the row reads one height
const CAP = { top: 9.75, h: 10 }
const D = { h: 30, gap: 30, inner: 7, sm: 13, md: 13, base: 13, barW: 76, barH: 6 }
// 图形按 30px 高的画布排版，输出时只取中间这一段（viewBox 裁掉上下留白），
// 让桌面端这条带子和上面的分支栏一样高
const CROP = { y: 6, h: 18 }
// Advance widths in em for Inter with tabular figures (SF Pro, the fallback, runs within a few %).
// Each text also sets textLength to this width, so a font that runs wider or narrower only
// changes letter spacing and never pushes into the next element.
const ADVANCE: Record<string, number> = { h: 0.58, d: 0.6, m: 0.9, K: 0.64, M: 0.84, '%': 0.84, '/': 0.36, '.': 0.27, ' ': 0.26 }
// Extra space between letters, in px; textLength spreads it evenly across each string
const TRACKING = 0.2
const textW = (v: string, size: number) =>
  [...v].reduce((w, c) => w + (c >= '0' && c <= '9' ? 0.62 : (ADVANCE[c] ?? 0.6)), 0) * size +
  TRACKING * Math.max(0, [...v].length - 1)

// Text tinted toward the hue: deeper on light backgrounds, lighter on dark ones
const pinW = (v: string, size: number) => `textLength="${textW(v, size).toFixed(1)}" lengthAdjust="spacing"`
const ink = (hue: string, x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="ink" style="--l:${lighten(hue, -0.38)};--d:${lighten(hue, 0.25)}">${esc(v)}</text>`
const mute = (x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="mute">${esc(v)}</text>`

// stat: type, icons and rules; motion: bars and dots with their shine
type Layers = { stat: string; motion: string }
type Group = { width: number; draw: (x: number) => Layers }

// 5h 60% ▬▬▬▬── 1h49m: the figure first, so the state reads before the bar
// 5h ▬▬▬▬▬▬──── 69% │ 1h31m: label, bar, figure, then when it resets
const limitGroup = (id: string, label: string, l: Limit, hue: string, at: number): Group => {
  const pct = Math.round(l.percentUsed)
  const color = limitColor(l, at, hue)
  const pctText = `${pct}%`
  const left = l.resetsAt ? fmtLeft(Date.parse(l.resetsAt) - at) : ''
  const labelW = textW(label, D.base) + D.inner
  const pctW = textW(pctText, D.base)
  const width = labelW + D.barW + D.inner + pctW + (left ? D.inner * 2 + 1 + textW(left, D.sm) : 0)
  const fillW = Math.max(pct > 0 ? D.barH : 0, Math.min(D.barW, (D.barW * pct) / 100))
  return {
    width,
    draw: x => {
      const bx = x + labelW
      const y = (D.h - D.barH) / 2
      const r = D.barH / 2
      const px = bx + D.barW + D.inner
      const motion = [
        `<defs><clipPath id="c-${id}"><rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}"/></clipPath></defs>`,
        `<rect x="${bx}" y="${y}" width="${D.barW}" height="${D.barH}" rx="${r}" class="track" style="--h:${color}"/>`,
        `<rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}" fill="${lighten(color, -0.12)}"/>`,
        // The shine crosses the whole bar on one shared clock and shows only over the fill,
        // so both bars' shines sit at the same spot at every moment
        `<g clip-path="url(#c-${id})"><rect y="${y}" width="18" height="${D.barH}" fill="url(#shine)">` +
          `<animate attributeName="x" values="${bx - 18};${bx + D.barW};${bx + D.barW}" keyTimes="0;0.62;1" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
      ]
      const stat = [ink(color, x, 19.5, label, D.base), ink(color, px, 19.5, pctText, D.base)]
      if (left) {
        const rx = px + pctW + D.inner
        stat.push(`<rect x="${rx}" y="${CAP.top}" width="1" height="${CAP.h}" class="rule"/>`, mute(rx + 1 + D.inner, 19.5, left, D.sm))
      }
      return { stat: stat.join(''), motion: motion.join('') }
    },
  }
}

// Three stacked sheets: the context window
const layersIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round">` +
  `<path d="M5 0.6 L9.4 2.8 L5 5 L0.6 2.8 Z" fill="${color}" fill-opacity="0.25"/>` +
  `<path d="M0.6 5.2 L5 7.4 L9.4 5.2"/><path d="M0.6 7.2 L5 9.4 L9.4 7.2"/></g>`

// A target: how much of the prompt the cache hit
const targetIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2">` +
  `<circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" fill="${color}"/></g>`

// Icons are drawn in a CAP.h square, outer stroke edge included
const ICON = CAP.h

// icon · NUMBER suffix
const typeGroup = (icon: (c: string) => string, hue: string, num: string, suffix: string): Group => {
  const lw = ICON + 6
  const nw = textW(num, D.md)
  const sw = suffix ? textW(suffix, D.sm) + 1 : 0
  return {
    width: lw + nw + sw,
    draw: x => {
      const nx = x + lw
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${icon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          (suffix ? mute(nx + nw + 1, 19.5, suffix, D.sm) : ''),
        motion: '',
      }
    },
  }
}

// Context as a 2×10 dot matrix: one dot per 1/20 of the window (50K of 1M), filling the top
// row left to right before the bottom one, with the same shine over the lit dots
// Rows sit so the dots' outer edges meet the CAP band: CAP.top + r and CAP.top + CAP.h - r
const DOTS = { cols: 10, pitch: 5, r: 1.6, rows: [11.35, 18.15] }
const ctxGroup = (hue: string, tokens: number, window: number, pct: number): Group => {
  const lit = Math.min(DOTS.cols * 2, Math.round((pct / 100) * DOTS.cols * 2))
  const num = fmtTokens(tokens)
  const suffix = `/${fmtTokens(window)}`
  const lw = ICON + 6
  const matrixW = DOTS.cols * DOTS.pitch
  return {
    width: lw + matrixW + D.inner + textW(num, D.md) + 1 + textW(suffix, D.sm),
    draw: x => {
      const mx = x + lw
      const dot = (i: number) =>
        `<circle cx="${mx + DOTS.pitch / 2 + (i % DOTS.cols) * DOTS.pitch}" cy="${DOTS.rows[Math.floor(i / DOTS.cols)]}" r="${DOTS.r}"/>`
      const on = Array.from({ length: lit }, (_, i) => dot(i)).join('')
      const off = Array.from({ length: DOTS.cols * 2 - lit }, (_, i) => dot(lit + i)).join('')
      const nx = mx + matrixW + D.inner
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${layersIcon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          mute(nx + textW(num, D.md) + 1, 19.5, suffix, D.sm),
        motion:
          `<defs><clipPath id="c-ctx">${on}</clipPath></defs>` +
          `<g class="track" style="--h:${hue}">${off}</g>` +
          `<g fill="${lighten(hue, -0.12)}">${on}</g>` +
          `<g clip-path="url(#c-ctx)"><rect y="8" width="18" height="14" fill="url(#shine)">` +
          `<animate attributeName="x" values="${mx - 18};${mx + matrixW};${mx + matrixW}" keyTimes="0;0.62;1" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
      }
    },
  }
}

// An image takes its color scheme from the app; a frame (should the band ever be framed) whose color scheme differs from the app's
// gets an opaque canvas behind it (white in a dark app). Declaring both schemes lets it follow the
// app and stay transparent.
const SVG_HEAD =
  `<style>` +
  `:root{color-scheme:light dark;background:transparent}` +
  `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;font-feature-settings:"tnum","cv05"}` +
  `.track{fill:var(--h);fill-opacity:.22}` +
  `.ink{fill:var(--l)}.mute{fill:#8b8f97;font-weight:400}.rule{fill:#000;fill-opacity:.1}.sep{fill:#000;fill-opacity:.2}` +
  `@media (prefers-color-scheme:dark){.ink{fill:var(--d)}.mute{fill:#9aa0a8}.rule{fill:#fff;fill-opacity:.13}.sep{fill:#fff;fill-opacity:.22}}` +
  `</style>` +
  `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`

const wrap = (width: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CROP.h}" viewBox="0 ${CROP.y} ${width} ${CROP.h}" style="color-scheme:light dark;background:transparent">${SVG_HEAD}${body}</svg>`

// 悬停卡片：title / detail 两行，限额组再加一行 forecast。只用带子上已经显示的精度
// （百分比、K/M、倒计时），免得每次 token 小变动都改写内容、触发重绘
type Card = { alt: string; title: string; detail: string; forecast?: Forecast }
export type Part = Layers & Card & { width: number }

const limitCard = (l: Limit, at: number, alt: string, title: string): Card => {
  const reset = l.resetsAt ? `，${fmtLeft(Date.parse(l.resetsAt) - at)} 后重置` : ''
  const f = forecast(l, at)
  return { alt, title, detail: `已用 ${Math.round(l.percentUsed)}%${reset}`, ...(f && { forecast: f }) }
}

export const desktopParts = (m: Measure | null, t: TurnTokens | null, at: number): Part[] => {
  const groups: (Card & { g: Group })[] = []
  const five = m?.rateLimits.find(l => l.kind === 'five_hour')
  const seven = m?.rateLimits.find(l => l.kind === 'seven_day')
  if (five)
    groups.push({
      g: limitGroup('5h', '5h', five, HUE.five, at),
      ...limitCard(five, at, `5-hour limit ${Math.round(five.percentUsed)}% used`, '5 小时额度'),
    })
  if (seven)
    groups.push({
      g: limitGroup('7d', '7d', seven, HUE.seven, at),
      ...limitCard(seven, at, `7-day limit ${Math.round(seven.percentUsed)}% used`, '7 天额度'),
    })
  if (m) {
    const pct = m.context.percent ?? 0
    const used = fmtTokens(m.context.tokens ?? 0)
    const total = fmtTokens(m.context.window)
    groups.push({
      g: ctxGroup(pct >= 80 ? RED : HUE.ctx, m.context.tokens ?? 0, m.context.window, pct),
      alt: `context ${used} of ${total}`,
      title: '上下文窗口',
      detail: `已用 ${used} / ${total}（${Math.round(pct)}%）`,
    })
  }
  const hit = t ? hitRate(t) : null
  if (t && hit !== null)
    groups.push({
      g: typeGroup(targetIcon, hit < 50 ? RED : HUE.cache, `${hit}%`, ''),
      alt: `cache hit ${hit}%`,
      title: '缓存命中率',
      detail: `上一轮 ${hit}%：读缓存 ${fmtTokens(t.cacheRead)} / 总输入 ${fmtTokens(t.input + t.cacheRead + t.cacheWrite)}`,
    })
  return groups.map(({ g, ...rest }) => {
    const width = Math.ceil(g.width + 2)
    return { ...g.draw(1), width, ...rest }
  })
}

export type BandPart = Card & { svg: string; width: number }

// 每组一张图，各自挂一张悬停卡片。整行两端对齐，组间距由排版均分，不画分隔细线，
// 这样和上方同样两端对齐的其他插件（如文档评审）左右边缘一致。各图的高光各自计时，只在某一组单独重绘时会错开
export const desktopBand = (m: Measure | null, t: TurnTokens | null, at: number): BandPart[] =>
  desktopParts(m, t, at).map(({ stat, motion, width, ...card }) => ({
    ...card,
    svg: wrap(width, `${stat}${motion}`),
    width,
  }))

// The desktop app redraws the band, and its frame blinks, on every write a drawing reads. So a
// reading is only written when it changes what the band shows: a new token count that rounds to
// the same figure, or a clock tick that leaves every countdown as it was, writes nothing.
const shown = (m: Measure | null, t: TurnTokens | null, at: number) => JSON.stringify(desktopBand(m, t, at))

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const [m, t, was] = [await read($, measure), await read($, turn), await read($, now)]
  if (was && shown(m, t, was) === shown(m, t, at)) return
  await update($, now, () => at)
}

const setMeasure = async ($: EngineInterface, next: Measure) => {
  const [m, t, at] = [await read($, measure), await read($, turn), await read($, now)]
  if (m && shown(m, t, at) === shown(next, t, at)) return
  await update($, measure, () => next)
}

const setTurn = async ($: EngineInterface, next: TurnTokens) => {
  const [m, t, at] = [await read($, measure), await read($, turn), await read($, now)]
  if (t && shown(m, t, at) === shown(m, next, at)) return
  await update($, turn, () => next)
}

// Shown by the preview when the session has no reading yet
const SAMPLE_MEASURE: Measure = {
  context: { tokens: 176_000, window: 1_000_000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
}
const SAMPLE_TURN: TurnTokens = { input: 900, output: 2_000, cacheRead: 170_000, cacheWrite: 1_000 }

const PROFILES: { name: string; look: Look }[] = [
  { name: 'Ghostty', look: { style: 'nerd', colors: 'true' } },
  { name: 'iTerm2 / Warp / WezTerm / kitty', look: { style: 'unicode', colors: 'true' } },
  { name: 'macOS Terminal (256 colors)', look: { style: 'unicode', colors: '256' } },
  { name: 'ascii fallback', look: { style: 'ascii', colors: '256' } },
]

// Icon set override, read from CC_GAUGE_ICONS. It is an environment variable rather than a
// plugin option so a fresh install has nothing to configure.
const ICONS_ENV = 'CC_GAUGE_ICONS'

export const WELCOME =
  'cc-gauge is on: your 5h and 7d limits, context window and cache hit rate now show above the prompt. ' +
  'The limits fill in after Claude’s first reply.'

// 终端下把这条带子画在输入框下方（PromptHint），桌面和移动端留在上方。
//
// PromptHint 没有 bodyColumns（它本来是按单行提示设计的），只能从 viewport 推；
// 而且引擎会在行首固定画一截「⏵⏵ auto mode on · 」，那截既不在我们的树里也拿
// 不到宽度 —— 所以让树的第一行空着把它挤成独立一行，再用负 margin 把带子拉回
// 行首。-20 是量出来的：四种权限模式下那截前缀最短约 20 格（plan / auto），
// 最长约 23 格（accept edits）。
let isAnimating = false
const HINT_PULL = 20

async function drawBand($: EngineInterface, e: any, next: any, atHint: boolean) {
  const m = await read($, measure)
  const t = await read($, turn)
  const at = await read($, now)
  if (e.props.hasSurvey || (m === null && t === null)) return next(e)

  // Desktop and mobile animate inside the SVG, so they never read the frame counter
  if (e.surface === 'desktop' || e.surface === 'mobile') {
    const { Box, Svg, Text } = $.ui.resolve(e)
    // 带 key 的 Box 是悬停锚点；其中 absolute + display:none + hover display:flex 的 Box
    // 会被桌面端提成应用自带样式的悬浮卡片（AbovePrompt 开了 liftsHoverCards）。
    // height={1} 在桌面端是一行高，带子因此和分支栏一样高
    return (
      <Box flexDirection="row" justifyContent="space-between" flexGrow={1}>
        {desktopBand(m, t, at).map(p => (
          <Box key={`g-${p.title}`} height={1} alignItems="center">
            <Svg source={p.svg} alt={p.alt} width={p.width} height={CROP.h} />
            <Box position="absolute" display="none" hover={{ display: 'flex' }} flexDirection="column">
              <Text bold>{p.title}</Text>
              <Text dimColor>{p.detail}</Text>
              {p.forecast &&
                (p.forecast.early ? (
                  <Text color={WARN}>{p.forecast.text}</Text>
                ) : (
                  <Text dimColor>{p.forecast.text}</Text>
                ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  }

  if (!isAnimating) {
    isAnimating = true
    $.clock.every(FRAME_MS, () => {
      void update($, phase, f => (f ?? 0) + 1)
    })
  }
  const frame = await read($, phase)
  // The terminal font decides icons; other surfaces (vscode) get the plain set
  const s = e.surface === 'terminal' ? await read($, style) : 'unicode'
  const columns = atHint
    ? (e.viewport?.columns ?? 120) - 4
    : e.props.bodyColumns - 2
  const spans = fit(m, t, at, columns, frame, { style: s, colors: 'true' })
  const { Box, Text } = $.ui.resolve(e)
  const band = (
    <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
      {spans.map((sp, i) => (
        <Text key={`s${i}`} color={sp.color} dimColor={sp.dim}>
          {sp.text}
        </Text>
      ))}
    </Box>
  )
  if (!atHint) return band
  return (
    <Box flexDirection="column" marginLeft={-HINT_PULL}>
      <Text key="gap"> </Text>
      {band}
    </Box>
  )
}

// 插件能画的元素类型；不在其中的是引擎自己的节点
const DRAWN_TYPES = new Set(['Text', 'Button', 'Svg', 'Markdown', 'Code', 'Link', 'Image', 'Raster', 'Input', 'Select', 'Client'])

// 渲染树里有没有插件画的可见内容；只有引擎节点或空盒子时为 false
export const hasDrawnContent = (node: any): boolean => {
  if (node === null || node === undefined || typeof node !== 'object') return typeof node === 'string' && node.trim() !== ''
  if (Array.isArray(node)) return node.some(hasDrawnContent)
  if (DRAWN_TYPES.has(node.type)) return true
  if (node.type !== 'Box') return false
  return hasDrawnContent(node.children)
}

// 横向分隔线：桌面端会把过宽的图缩放到行宽，线用 non-scaling-stroke 保持 1 像素
const DIVIDER = (() => {
  const width = 2000
  // 线上下各约 10pt，加上药丸和用量带自身的上下内边距，正好和外层容器的内边距（约 17pt）一致
  const height = 20
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `<style>.rule{stroke:#000;stroke-opacity:.12}@media (prefers-color-scheme:dark){.rule{stroke:#fff;stroke-opacity:.16}}</style>` +
    `<line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" class="rule" vector-effect="non-scaling-stroke"/></svg>`
  return { svg, width, height }
})()

export const register: Register = on => {
  let setting = 'auto'
  // The terminal animates by redrawing; started by its first draw, so a desktop-only session
  // never runs it. A reload drops the timer and this flag together.

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    setting = ((await $.env.get('CC_GAUGE_ICONS')) ?? 'auto').trim().toLowerCase() || 'auto'
    const term = await $.env.get('TERM_PROGRAM')
    await update($, style, () => detectStyle(setting, term))
    await $.command.register({
      name: PREVIEW,
      description: 'Preview how cc-gauge looks in different terminals',
    })
    // One welcome after install, so a new user knows what appeared above the prompt
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast(WELCOME, { timeoutMs: 12_000 })
    }
    const usage = await $.session.usage()
    await setMeasure($, { context: usage.context, rateLimits: usage.rateLimits })
    await tick($)
    $.clock.every(60_000, () => {
      void tick($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const m: Measure = {
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      rateLimits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    }
    await setMeasure($, m)
    await tick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; subagent runs raise their own turn.complete
    if (e.agentId === undefined && e.usage) {
      const u = e.usage
      await setTurn($, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      })
    }
    return next(e)
  })

  on('command.run', { command: PREVIEW }, async () => ({
    text: `cc-gauge style preview (${ICONS_ENV}: ${setting})`,
  }))

  on('ui.render', { component: 'CommandOutput', props: { command: PREVIEW } }, async ($, e) => {
    const m = (await read($, measure)) ?? SAMPLE_MEASURE
    const t = (await read($, turn)) ?? SAMPLE_TURN
    const at = await read($, now)
    const current = await read($, style)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {ICONS_ENV}: {setting} → using {current}
        </Text>
        {PROFILES.map(p => (
          <Box key={p.name} flexDirection="column" marginTop={1}>
            <Text dimColor>{p.name}</Text>
            <Box flexDirection="row">
              {layout(m, t, at, 2, 3, p.look).map((s, i) => (
                <Text key={`s${i}`} color={s.color} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 终端改画在输入框下面了，这里让位
    if (e.surface === 'terminal') return next(e)
    // 这块位置由多个插件共用、按加载顺序一层套一层：自己画完也把内层画的接上，放在用量带上面，
    // 不论谁在外层，别的插件（如文档评审）都在上、用量带在下
    let isPassed = false
    const band = await drawBand($, e, (x: any) => ((isPassed = true), next(x)), false)
    if (isPassed) return band
    // 内层（别的插件或引擎）出错不能连累用量带：只画自己
    let inner
    try {
      inner = await next(e)
    } catch {
      return band
    }
    if (inner === null || inner === undefined) return band
    const { Box, Svg } = $.ui.resolve(e)
    // 内层内容里可能有引擎自己的节点，而引擎节点不能放在设了 width 的 Box 下面（整块会被拒绝）：
    // 包着它的 stack、inner 都不设宽度，靠纵向排列的拉伸铺满；只有用量带自己那一格设 width。
    // 分隔线只在内层确实画了东西（不只是引擎的空节点）时才画
    const showsInner = hasDrawnContent(inner)
    return (
      <Box key="stack" flexDirection="column" alignItems="stretch">
        <Box key="inner" flexDirection="column" alignItems="stretch">
          {inner}
        </Box>
        {showsInner && (
          <Box key="divider" width="100%" overflow="hidden">
            <Svg source={DIVIDER.svg} alt="分隔线" width={DIVIDER.width} height={DIVIDER.height} />
          </Box>
        )}
        <Box key="usage" width="100%">
          {band}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    return drawBand($, e, next, true)
  })
}
