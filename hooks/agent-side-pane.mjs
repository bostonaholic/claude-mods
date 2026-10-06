import { atom, read, update } from 'claude-code'

const PANE_ID = 'agent-pane'
const PANE_TITLE = 'Agents'
const COMMAND = 'agent-pane'
const SUMMARY_MAX_CHARS = 160
const OFFERED_EMPTY = 'No agent types are offered in this session.'
const FIRST_PROMPT_EMPTY = 'No agent types yet. They appear after your first prompt.'
const NOTE = 'Custom agents only. Built-in agents and descriptions appear after your first prompt.'
const START_PROMPT =
  'You were started from the agent side pane with no specific task. Do the work your agent definition describes for the current project, then report what you did.'
const SPAWN_DESCRIPTION = 'Started from agent pane'

const catalog = atom({ plugin: 'bostonaholic-mods', key: 'agentPaneCatalog' }, { isListed: false, types: [] })
const starts = atom({ plugin: 'bostonaholic-mods', key: 'agentPaneStarts' }, {})

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
 * @param {{ name: string; summary: string; isOffered: boolean }} offer
 * @returns {import('../types').AgentPaneCatalog} `current` itself when the offer changes nothing
 */
function applyOffer(current, { name, summary, isOffered }) {
  const listed = current.types.find(type => type.name === name)
  const isUnchanged = current.isListed && (isOffered ? listed?.summary === summary : listed === undefined)
  if (isUnchanged) {
    return current
  }

  const others = current.types.filter(type => type.name !== name)
  const types = isOffered ? [...others, { name, summary }].sort(byName) : others

  return { isListed: true, types }
}

/** @param {unknown} error */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {import('claude-code').SessionUsage} usage
 * @returns {string[]} the custom agent type names, in breakdown order
 */
function usageAgentNames(usage) {
  const agents = usage.context.breakdown?.agents
  if (!Array.isArray(agents)) {
    return []
  }

  return agents.map(agent => agent.agentType).filter(name => typeof name === 'string' && name !== '')
}

/**
 * The engine offers no agent listing before the first prompt, and the usage
 * breakdown is the one source that names custom agent types until then.
 *
 * @param {import('claude-code').EngineInterface} $
 */
async function readUsageNames($) {
  let usage
  try {
    usage = await $.session.usage({ breakdown: 'summary' })
  } catch (error) {
    $.ui.log(`agent pane: reading custom agent types failed: ${reasonOf(error)}`, { to: 'debug' })

    return []
  }

  return usageAgentNames(usage)
}

/** @param {import('claude-code').EngineInterface} $ */
async function openPane($) {
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
 * @param {string} name
 * @returns {Promise<import('../types').AgentPaneStart>}
 */
async function spawnAgent($, name) {
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

  return spawned.agentId === undefined ? { status: 'started' } : { status: 'started', agentId: spawned.agentId }
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
 * @param {Set<string>} inFlight
 * @param {string} name
 */
async function startAgent($, inFlight, name) {
  if (inFlight.has(name)) {
    return
  }

  inFlight.add(name)
  try {
    await recordStart($, name, { status: 'starting' })
    await recordStart($, name, await spawnAgent($, name))
  } finally {
    inFlight.delete(name)
  }
}

/**
 * @param {string} name
 * @param {import('../types').AgentPaneStart} start
 */
function statusLine(Box, Text, name, start) {
  const text =
    start.status === 'failed'
      ? h(Text, { color: 'red' }, `failed: ${start.reason}`)
      : h(Text, { dimColor: true }, start.status)

  return h(Box, { key: `status:${name}` }, text)
}

function agentRow({ Box, Button, Text }, { name, summary }, start, onStart) {
  const statusBox = start === undefined ? [] : [statusLine(Box, Text, name, start)]
  const summaryText = summary === '' ? [] : [h(Text, { dimColor: true }, summary)]

  return h(
    Box,
    { key: `row:${name}`, flexDirection: 'column' },
    h(
      Box,
      { flexDirection: 'row', gap: 1 },
      h(Button, { key: `start:${name}`, label: 'Start', onPress: onStart }),
      h(Text, { bold: true }, name),
      ...statusBox,
    ),
    ...summaryText,
  )
}

function emptyText(Box, Text, text) {
  return h(Box, { key: 'empty' }, h(Text, { dimColor: true }, text))
}

function listedBody(Box, Text, types, row) {
  return types.length === 0 ? [emptyText(Box, Text, OFFERED_EMPTY)] : types.map(row)
}

function usageBody(Box, Text, names, row) {
  if (names.length === 0) {
    return [emptyText(Box, Text, FIRST_PROMPT_EMPTY)]
  }

  return [h(Box, { key: 'note' }, h(Text, { dimColor: true }, NOTE)), ...names.map(name => row({ name, summary: '' }))]
}

/** @type {import('claude-code').Register} */
export const register = on => {
  /** @type {Set<string>} */
  const inFlight = new Set()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show every agent type in a side pane', immediate: true })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: await openPane($) }))

  on('agent.offer', async ($, e, next) => {
    const result = await next(e)
    const offer = { name: e.agent, summary: summarize(e.description), isOffered: result.isOffered }
    const current = await read($, catalog)
    if (applyOffer(current, offer) !== current) {
      await update($, catalog, latest => applyOffer(latest, offer))
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const { isListed, types } = await read($, catalog)
    const startsByName = await read($, starts)
    const row = type => agentRow(elements, type, startsByName[type.name], () => startAgent($, inFlight, type.name))
    const body = isListed ? listedBody(Box, Text, types, row) : usageBody(Box, Text, await readUsageNames($), row)

    return /** @type {import('claude-code').RenderElement} */ (
      h(Box, { flexDirection: 'column', width: e.props.bodyColumns }, ...body)
    )
  })
}
