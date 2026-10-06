import { atom, read, update } from 'claude-code'

const PANE_ID = 'agent-pane'
const PANE_TITLE = 'Agents'
const COMMAND = 'agent-pane'
const SUMMARY_MAX_CHARS = 160
const OFFERED_EMPTY = 'No agent types are offered in this session.'
const FIRST_PROMPT_EMPTY = 'No agent types yet. They appear after your first prompt.'
const NOTE = 'Custom agents only. Built-in agents and descriptions appear after your first prompt.'
const FOOTER = `click ▶ run to start one · /${COMMAND} to hide`
const START_PROMPT =
  'You were started from the agent side pane with no specific task. Do the work your agent definition describes for the current project, then report what you did.'
const SPAWN_DESCRIPTION = 'Started from agent pane'
const TICK_MS = 1000

// Theme keys only, never raw colors, so every run follows the person's Claude
// Code theme: dark, light, their daltonized (color-blind) variants and the
// ANSI ones that defer to the terminal's own palette. The pane paints the
// theme's background, so text with no color would fall back to the
// terminal's foreground and vanish when terminal and theme disagree (a light
// theme in a dark terminal). Text is drawn in `text`, dim, or `error`; hue
// marks only glyphs, which the name beside them always explains.
const ACCENT = 'claude'
const TEXT = 'text'
const ERROR_COLOR = 'error'
// The theme's agent colors, as Claude Code draws agents. Blue takes `ide`, the
// theme's blue in every variant: `blue_FOR_SUBAGENTS_ONLY` draws no color under
// the ANSI themes.
const DOT_COLORS = {
  blue: 'ide',
  cyan: 'cyan_FOR_SUBAGENTS_ONLY',
  yellow: 'yellow_FOR_SUBAGENTS_ONLY',
  orange: 'orange_FOR_SUBAGENTS_ONLY',
  purple: 'purple_FOR_SUBAGENTS_ONLY',
  red: 'red_FOR_SUBAGENTS_ONLY',
  green: 'green_FOR_SUBAGENTS_ONLY',
  pink: 'pink_FOR_SUBAGENTS_ONLY',
}
const DOT_PALETTE = Object.values(DOT_COLORS)

/** Display order and labels for the engine's agent `source` values. */
const SECTIONS = [
  { source: 'projectSettings', label: 'PROJECT', hint: '.claude/agents' },
  { source: 'userSettings', label: 'USER', hint: '~/.claude/agents' },
  { source: 'plugin', label: 'PLUGIN', hint: 'plugins' },
  { source: 'built-in', label: 'BUILT-IN', hint: 'Claude Code' },
]

const catalog = atom({ plugin: 'bostonaholic', key: 'agentPaneCatalog' }, { isListed: false, types: [] })
const starts = atom({ plugin: 'bostonaholic', key: 'agentPaneStarts' }, {})
const meta = atom({ plugin: 'bostonaholic', key: 'agentPaneMeta' }, {})

/**
 * @param {string} description
 * @returns {string} the first line, at most SUMMARY_MAX_CHARS long
 */
function summarize(description) {
  const firstLine = description.split('\n')[0]

  return firstLine.length > SUMMARY_MAX_CHARS ? `${firstLine.slice(0, SUMMARY_MAX_CHARS - 1)}…` : firstLine
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Case-insensitive, so built-in `Explore` sorts among custom lowercase names.
 *
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 */
function byName(a, b) {
  return compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.name, b.name)
}

/**
 * @param {import('../types').AgentPaneCatalog} current
 * @param {{ name: string; summary: string; source: string; isOffered: boolean }} offer
 * @returns {import('../types').AgentPaneCatalog} `current` itself when the offer changes nothing
 */
function applyOffer(current, { name, summary, source, isOffered }) {
  const listed = current.types.find(type => type.name === name)
  const isSame = listed?.summary === summary && listed?.source === source
  const isUnchanged = current.isListed && (isOffered ? isSame : listed === undefined)
  if (isUnchanged) {
    return current
  }

  const others = current.types.filter(type => type.name !== name)
  const types = isOffered ? [...others, { name, summary, source }].sort(byName) : others

  return { isListed: true, types }
}

/** @param {unknown} error */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {import('claude-code').SessionUsage} usage
 * @returns {import('../types').AgentPaneType[]} the custom agent types, in breakdown order
 */
function usageAgentTypes(usage) {
  const agents = usage.context.breakdown?.agents
  if (!Array.isArray(agents)) {
    return []
  }

  return agents
    .filter(agent => typeof agent.agentType === 'string' && agent.agentType !== '')
    .map(agent => ({ name: agent.agentType, summary: '', source: String(agent.source ?? '') }))
}

/**
 * The engine offers no agent listing before the first prompt, and the usage
 * breakdown is the one source that names custom agent types until then.
 *
 * @param {import('claude-code').EngineInterface} $
 */
async function readUsageTypes($) {
  let usage
  try {
    usage = await $.session.usage({ breakdown: 'summary' })
  } catch (error) {
    $.ui.log(`agent pane: reading custom agent types failed: ${reasonOf(error)}`, { to: 'debug' })

    return []
  }

  return usageAgentTypes(usage)
}

/**
 * Reads the `name`, `model` and `color` keys of a Markdown file's YAML front
 * matter. Only flat `key: value` lines are read; anything else is ignored.
 *
 * @param {string} text
 * @returns {{ name?: string; model?: string; color?: string }}
 */
function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) {
    return {}
  }

  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|model|color):\s*['"]?([^'"#]*?)['"]?\s*$/.exec(line)
    if (field !== null && field[2] !== '') {
      fields[field[1]] = field[2]
    }
  }

  return fields
}

/**
 * @param {import('claude-code').EngineInterface} $
 * @param {string} dir
 * @returns {Promise<Record<string, import('../types').AgentPaneMeta>>} model and color by agent name
 */
async function readAgentDir($, dir) {
  const found = {}
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return found
  }

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) {
      continue
    }

    try {
      const { name, model, color } = frontMatter(await $.fs.read(`${dir}/${entry.name}`))
      found[name ?? entry.name.slice(0, -3)] = { model, color }
    } catch (error) {
      $.ui.log(`agent pane: reading ${entry.name} failed: ${reasonOf(error)}`, { to: 'debug' })
    }
  }

  return found
}

/**
 * Model and color from the user's and the project's agent files; the
 * project's definition wins a name both define, as it does in the engine.
 *
 * @param {import('claude-code').EngineInterface} $
 */
async function readAgentMeta($) {
  let home
  try {
    home = await $.env.get('HOME')
  } catch {
    home = undefined
  }

  const user = home === undefined ? {} : await readAgentDir($, `${home}/.claude/agents`)

  return { ...user, ...(await readAgentDir($, '.claude/agents')) }
}

/** @param {import('claude-code').EngineInterface} $ */
async function isPaneShown($) {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE_ID && pane.isShown)
  } catch {
    return false
  }
}

/** @param {import('claude-code').EngineInterface} $ */
async function togglePane($) {
  if (await isPaneShown($)) {
    await $.ui.close({ id: PANE_ID })

    return 'Closed the agent pane.'
  }

  const found = await readAgentMeta($)
  await update($, meta, () => found)

  let opened
  try {
    opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true })
  } catch (error) {
    return `The agent pane could not open: ${reasonOf(error)}`
  }

  return opened.isPlaced ? 'Opened the agent pane.' : `The agent pane waits: ${opened.reason}`
}

/**
 * @param {import('claude-code').EngineInterface} $
 * @param {Map<string, { type: string; startedAt: number }>} runs
 * @param {string} name
 * @returns {Promise<import('../types').AgentPaneStart>}
 */
async function spawnAgent($, runs, name) {
  let spawned
  try {
    spawned = await $.agent.spawn({ prompt: START_PROMPT, subagentType: name, description: SPAWN_DESCRIPTION })
  } catch (error) {
    $.ui.log(`agent pane: starting ${name} failed: ${reasonOf(error)}`, { to: 'debug' })

    return { status: 'failed', reason: reasonOf(error) }
  }

  if (spawned.deny !== undefined) {
    return { status: 'failed', reason: spawned.deny }
  }

  if (spawned.agentId === undefined) {
    return { status: 'started' }
  }

  runs.set(spawned.agentId, { type: name, startedAt: await $.clock.now() })

  return { status: 'started', agentId: spawned.agentId }
}

/**
 * @param {import('claude-code').EngineInterface} $
 * @param {string} name
 * @param {import('../types').AgentPaneStart} start
 */
function recordStart($, name, start) {
  return update($, starts, current => ({ ...current, [name]: start }))
}

/**
 * Starts one agent of type `name` unless a start of that type is still in flight.
 *
 * @param {import('claude-code').EngineInterface} $
 * @param {{ inFlight: Set<string>; runs: Map<string, { type: string; startedAt: number }> }} session
 * @param {string} name
 */
async function startAgent($, { inFlight, runs }, name) {
  if (inFlight.has(name)) {
    return
  }

  inFlight.add(name)
  try {
    await recordStart($, name, { status: 'starting' })
    await recordStart($, name, await spawnAgent($, runs, name))
  } finally {
    inFlight.delete(name)
  }
}

/**
 * The agents running now, by type: the earliest start time this module saw
 * for that type, or `undefined` for one started before the module loaded.
 * Forgets the runs that ended.
 *
 * @param {import('claude-code').EngineInterface} $
 * @param {Map<string, { type: string; startedAt: number }>} runs
 * @returns {Promise<{ count: number; byType: Map<string, number | undefined> }>}
 */
async function readRunning($, runs) {
  let loops
  try {
    loops = await $.agent.list()
  } catch {
    loops = []
  }

  const running = loops.filter(loop => loop.status === 'running')
  const runningIds = new Set(running.map(loop => loop.id))
  for (const id of runs.keys()) {
    if (!runningIds.has(id)) {
      runs.delete(id)
    }
  }

  const byType = new Map()
  for (const loop of running) {
    const startedAt = runs.get(loop.id)?.startedAt
    const earliest = byType.get(loop.type)
    byType.set(loop.type, earliest === undefined ? startedAt : Math.min(earliest, startedAt ?? earliest))
  }

  return { count: running.length, byType }
}

/** @param {number} ms */
function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** @param {string} name */
function hashColor(name) {
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)) >>> 0
  }

  return DOT_PALETTE[hash % DOT_PALETTE.length]
}

/**
 * @param {string} name
 * @param {string | undefined} color an agent file's `color`, a palette name or a raw color
 */
function dotColor(name, color) {
  return color === undefined ? hashColor(name) : (DOT_COLORS[color] ?? color)
}

function header({ Box, Text }, runningCount) {
  const running = runningCount === 0 ? [] : [h(Text, { dimColor: true }, `◌ ${runningCount} running`)]

  return h(
    Box,
    { key: 'header', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 1 },
    h(
      Box,
      { flexDirection: 'row', gap: 1 },
      h(Text, { color: ACCENT }, '◆'),
      h(Text, { bold: true, color: TEXT }, 'Agents'),
      h(Text, { dimColor: true }, 'in this project'),
    ),
    ...running,
  )
}

function sectionHeader({ Box, Text }, section, count, columns) {
  const caption = `${section.hint} · ${count}`
  const ruleWidth = Math.max(0, columns - section.label.length - caption.length - 2)

  return h(
    Box,
    { key: `section:${section.source}`, flexDirection: 'row', gap: 1, marginTop: 1 },
    h(Text, { bold: true, color: TEXT }, section.label),
    h(Text, { dimColor: true }, caption),
    h(Box, { flexGrow: 1 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, '─'.repeat(ruleWidth))),
  )
}

/**
 * The right side of a row: the run time while an agent of this type runs,
 * otherwise the run button, led by `starting` while a start is in flight.
 */
function rowAction({ Box, Button, Text }, name, start, runningSince, now, onStart) {
  if (runningSince !== null) {
    const label = runningSince === undefined ? 'running' : `running · ${elapsed(now - runningSince)}`

    return [
      h(
        Box,
        { key: `status:${name}`, flexDirection: 'row', gap: 1 },
        h(Text, { color: ACCENT }, '◌'),
        h(Text, { color: TEXT }, label),
      ),
    ]
  }

  const starting = start?.status === 'starting' ? [h(Box, { key: `status:${name}` }, h(Text, { dimColor: true }, 'starting'))] : []

  return [...starting, h(Button, { key: `start:${name}`, label: '▶ run', variant: 'primary', onPress: onStart })]
}

function agentRow(elements, type, info, onStart) {
  const { Box, Text } = elements
  const { name, summary } = type
  const { start, model, color, runningSince, now } = info
  const modelText = model === undefined ? [] : [h(Text, { dimColor: true }, model)]
  const summaryText =
    summary === '' ? [] : [h(Box, { paddingLeft: 2 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, summary))]
  const failed =
    start?.status === 'failed'
      ? [h(Box, { key: `status:${name}`, paddingLeft: 2 }, h(Text, { color: ERROR_COLOR }, `failed: ${start.reason}`))]
      : []

  return h(
    Box,
    { key: `row:${name}`, flexDirection: 'column', marginTop: 1 },
    h(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      h(
        Box,
        { flexDirection: 'row', gap: 1, flexShrink: 1 },
        h(Text, { color: dotColor(name, color) }, '●'),
        h(Text, { bold: true, color: TEXT }, name),
        ...modelText,
      ),
      h(Box, { flexDirection: 'row', gap: 1 }, ...rowAction(elements, name, start, runningSince, now, onStart)),
    ),
    ...summaryText,
    ...failed,
  )
}

/**
 * @param {import('../types').AgentPaneType[]} types
 * @returns {{ section: { source: string; label: string; hint: string }; types: import('../types').AgentPaneType[] }[]}
 */
function groupBySource(types) {
  const known = SECTIONS.map(section => ({ section, types: types.filter(type => type.source === section.source) }))
  const otherSources = [...new Set(types.map(type => type.source))].filter(
    source => !SECTIONS.some(section => section.source === source),
  )
  const others = otherSources.map(source => ({
    section: { source, label: (source.replace(/Settings$/, '') || 'OTHER').toUpperCase(), hint: 'settings' },
    types: types.filter(type => type.source === source),
  }))

  return [...known, ...others].filter(group => group.types.length > 0)
}

function emptyText(Box, Text, text) {
  return h(Box, { key: 'empty', marginTop: 1 }, h(Text, { dimColor: true }, text))
}

function body(elements, types, row, columns) {
  return groupBySource(types).flatMap(({ section, types: sectionTypes }) => [
    sectionHeader(elements, section, sectionTypes.length, columns),
    ...sectionTypes.map(row),
  ])
}

/** @type {import('claude-code').Register} */
export const register = on => {
  const session = {
    /** @type {Set<string>} */
    inFlight: new Set(),
    /** Agents this module saw start, by agent id. */
    /** @type {Map<string, { type: string; startedAt: number }>} */
    runs: new Map(),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the agent side pane', immediate: true })
    $.clock.every(TICK_MS, () => {
      if (session.runs.size > 0) {
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: await togglePane($) }))

  on('agent.offer', async ($, e, next) => {
    const result = await next(e)
    const offer = { name: e.agent, summary: summarize(e.description), source: e.source, isOffered: result.isOffered }
    const current = await read($, catalog)
    if (applyOffer(current, offer) !== current) {
      await update($, catalog, latest => applyOffer(latest, offer))
    }

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId !== undefined && e.subagentType !== undefined) {
      session.runs.set(result.agentId, { type: e.subagentType, startedAt: await $.clock.now() })
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const columns = e.props.bodyColumns
    const { isListed, types: offered } = await read($, catalog)
    const startsByName = await read($, starts)
    const metaByName = await read($, meta)
    const running = await readRunning($, session.runs)
    const now = await $.clock.now()
    const types = isListed ? offered : await readUsageTypes($)

    const row = type => {
      const found = Object.hasOwn(metaByName, type.name) ? metaByName[type.name] : {}
      const info = {
        start: Object.hasOwn(startsByName, type.name) ? startsByName[type.name] : undefined,
        model: found.model,
        color: found.color,
        runningSince: running.byType.has(type.name) ? running.byType.get(type.name) : null,
        now,
      }

      return agentRow(elements, type, info, () => startAgent($, session, type.name))
    }

    const note = !isListed && types.length > 0 ? [h(Box, { key: 'note' }, h(Text, { dimColor: true }, NOTE))] : []
    const rows = types.length === 0 ? [emptyText(Box, Text, isListed ? OFFERED_EMPTY : FIRST_PROMPT_EMPTY)] : body(elements, types, row, columns)

    return /** @type {import('claude-code').RenderElement} */ (
      h(
        Box,
        { flexDirection: 'column', width: columns },
        header(elements, running.count),
        ...note,
        ...rows,
        h(Box, { key: 'footer', marginTop: 1 }, h(Text, { dimColor: true }, FOOTER)),
      )
    )
  })
}
