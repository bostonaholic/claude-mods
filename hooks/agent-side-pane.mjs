import { atom, read, update } from 'claude-code'

const PANE_ID = 'agent-pane'
const PANE_TITLE = 'Agents'
const COMMAND = 'agent-pane'
const SUMMARY_MAX_CHARS = 160
const OFFERED_EMPTY = 'No agent types are offered in this session.'
const FIRST_PROMPT_EMPTY = 'No agent types yet. They appear after your first prompt.'

const catalog = atom({ plugin: 'bostonaholic-mods', key: 'agentPaneCatalog' }, { isListed: false, types: [] })

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

function agentRow(Box, Text, { name, summary }) {
  const summaryText = summary === '' ? [] : [h(Text, { dimColor: true }, summary)]

  return h(Box, { key: `row:${name}`, flexDirection: 'column' }, h(Text, { bold: true }, name), ...summaryText)
}

function emptyText(Box, Text, text) {
  return h(Box, { key: 'empty' }, h(Text, { dimColor: true }, text))
}

/** @type {import('claude-code').Register} */
export const register = on => {
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
    const { Box, Text } = $.ui.resolve(e)
    const { isListed, types } = await read($, catalog)
    const body = !isListed
      ? [emptyText(Box, Text, FIRST_PROMPT_EMPTY)]
      : types.length === 0
        ? [emptyText(Box, Text, OFFERED_EMPTY)]
        : types.map(type => agentRow(Box, Text, type))

    return /** @type {import('claude-code').RenderElement} */ (
      h(Box, { flexDirection: 'column', width: e.props.bodyColumns }, ...body)
    )
  })
}
