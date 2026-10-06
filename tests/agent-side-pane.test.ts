import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Mounted, Plugin } from 'claude-code/testing'
import type { AgentOfferInput, AgentSpawnInput, AgentSpawnResult, On, OpEventResult } from 'claude-code'

const PLUGIN = 'bostonaholic-mods'
const SURFACES = ['terminal', 'desktop'] as const

type PaneDrawing = Mounted<(typeof SURFACES)[number], 'Pane'>

const PANE_PROPS = {
  title: 'Agents',
  isFocused: true,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const COMMAND_ORIGIN = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 120 } as const

const OFFERED_EMPTY = 'No agent types are offered in this session.'
const FIRST_PROMPT_EMPTY = 'No agent types yet. They appear after your first prompt.'
const NOTE = 'Custom agents only. Built-in agents and descriptions appear after your first prompt.'
const SPAWN_DESCRIPTION = 'Started from agent pane'

const LINE_300 = '0123456789'.repeat(30)
const SUMMARY_160 =
  '012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678…'

const STARTED: AgentSpawnResult = { model: 'haiku', agentId: 'agent-started-1' }

type OfferRow = { agent: string; description: string; source: string; isOffered: boolean }

function offerOf(agent: string, description: string, source = 'built-in'): AgentOfferInput {
  return { agent, description, source, provider: { plugin: 'engine', tier: 'core' } }
}

// Answers the ops the plugin calls whose answers no test asserts.
function answerUnassertedOps(on: On) {
  on('ui.log', () => ({ value: undefined }))
}

// Answers each offer with the next row's `isOffered`, in the order the test raises them.
function answerOffersInOrder(on: On, offers: readonly OfferRow[]) {
  const answers = offers.map(offer => offer.isOffered)
  on('agent.offer', () => ({ isOffered: answers.shift() ?? false }))
}

async function raiseInOrder($: Engine, offers: readonly OfferRow[]) {
  const results = []
  for (const offer of offers) {
    results.push(await $.agent.offer(offerOf(offer.agent, offer.description, offer.source)))
  }
  return results
}

function mountPane<S extends (typeof SURFACES)[number]>($: Engine, surface: S) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'agent-pane', props: PANE_PROPS })
}

function runAgentPane($: Engine, args = '') {
  return $.command.run({ command: 'agent-pane', args, origin: COMMAND_ORIGIN, presentation: PRESENTATION })
}

async function rowKeys(ui: PaneDrawing) {
  return (await ui.findAll({ type: 'Box' })).map(box => box.key).filter(key => key?.startsWith('row:'))
}

async function shownTexts(ui: PaneDrawing) {
  return (await ui.findAll({ type: 'Text' })).map(text => text.text)
}

async function textOf(ui: PaneDrawing, key: string) {
  return (await ui.find({ key }))?.text
}

// The kit hands a plugin's spawn to the hook beneath in the Agent tool's
// shape (`subagent_type`); the declaration names the field `subagentType`.
function spawnedType(e: AgentSpawnInput): unknown {
  const input = e as unknown as Record<string, unknown>
  return input.subagentType ?? input.subagent_type
}

// A usage answer holding only the fields the pane reads.
function usageAnswer(context: unknown): OpEventResult<'session.usage'> {
  return { value: { startedAt: 0, rateLimits: [], context } } as unknown as OpEventResult<'session.usage'>
}

// Another plugin that reads the catalog's state version, which only a real write changes.
const CATALOG_READER: Plugin = {
  name: 'catalog-reader',
  register(on) {
    on('command.run', { command: 'catalog-version' }, async $ => {
      const { version } = await $.state.get({ plugin: 'bostonaholic-mods', key: 'agentPaneCatalog' })

      return { text: String(version) }
    })
  },
}

async function catalogVersion($: Engine) {
  return (await $.command.run({ command: 'catalog-version', args: '', origin: COMMAND_ORIGIN, presentation: PRESENTATION })).text
}

describe('slice 1: open the pane and list the offered agent types', () => {
  const OPEN_CASES: readonly { label: string; args: string; answer: OpEventResult<'ui.open'>; text: RegExp }[] = [
    {
      label: 'placed',
      args: '',
      answer: { value: { isPlaced: true } },
      text: /^Opened the agent pane\.$/,
    },
    {
      label: 'isPlaced false',
      args: '',
      answer: { value: { isPlaced: false, reason: 'unasked panes wait below 144 columns, now 100' } },
      text: /^The agent pane waits: unasked panes wait below 144 columns, now 100$/,
    },
    {
      label: 'a rejection',
      args: '',
      answer: { deny: 'a policy plugin refused the pane' },
      text: /^The agent pane could not open: .*a policy plugin refused the pane$/,
    },
    {
      label: 'a run with arguments',
      args: 'Explore --now',
      answer: { value: { isPlaced: true } },
      text: /^Opened the agent pane\.$/,
    },
  ]

  for (const row of OPEN_CASES) {
    test(`/agent-pane opens the focused agent pane and reports placement: ${row.label}`, async ($, on) => {
      answerUnassertedOps(on)
      const opened: unknown[] = []
      on('ui.open', (_$, e) => {
        opened.push(e)

        return row.answer
      })

      const answer = await runAgentPane($, row.args)

      expect(opened).toEqual([expect.objectContaining({ id: 'agent-pane', title: 'Agents', focus: true })])
      expect(answer.text).toMatch(row.text)
    })
  }

  const LIST_CASES: readonly {
    label: string
    offers: readonly OfferRow[]
    results: readonly { isOffered: boolean }[]
    rows: readonly string[]
    texts: readonly string[]
    empty: string | undefined
  }[] = [
    {
      label: 'three types offered out of order',
      offers: [
        {
          agent: 'Plan',
          description: 'Plans the implementation\nReturns a step-by-step plan',
          source: 'built-in',
          isOffered: true,
        },
        { agent: 'Explore', description: 'Explores the codebase', source: 'built-in', isOffered: true },
        { agent: 'Bisect', description: 'Finds the commit that broke a test', source: 'userSettings', isOffered: true },
      ],
      results: [{ isOffered: true }, { isOffered: true }, { isOffered: true }],
      rows: ['row:Bisect', 'row:Explore', 'row:Plan'],
      texts: [
        'Bisect',
        'Finds the commit that broke a test',
        'Explore',
        'Explores the codebase',
        'Plan',
        'Plans the implementation',
      ],
      empty: undefined,
    },
    {
      label: 'a type answered isOffered false beneath',
      offers: [
        { agent: 'Explore', description: 'Explores the codebase', source: 'built-in', isOffered: true },
        { agent: 'Plan', description: 'Plans the implementation', source: 'built-in', isOffered: false },
      ],
      results: [{ isOffered: true }, { isOffered: false }],
      rows: ['row:Explore'],
      texts: ['Explore', 'Explores the codebase'],
      empty: undefined,
    },
    {
      label: 'a type answered true, then false',
      offers: [
        { agent: 'Plan', description: 'Plans the implementation', source: 'built-in', isOffered: true },
        { agent: 'Explore', description: 'Explores the codebase', source: 'built-in', isOffered: true },
        { agent: 'Plan', description: 'Plans the implementation', source: 'built-in', isOffered: false },
      ],
      results: [{ isOffered: true }, { isOffered: true }, { isOffered: false }],
      rows: ['row:Explore'],
      texts: ['Explore', 'Explores the codebase'],
      empty: undefined,
    },
    {
      label: 'one name offered twice with different source',
      offers: [
        { agent: 'reviewer', description: 'Reviews code from user settings', source: 'userSettings', isOffered: true },
        { agent: 'reviewer', description: 'Reviews code from the project', source: 'projectSettings', isOffered: true },
      ],
      results: [{ isOffered: true }, { isOffered: true }],
      rows: ['row:reviewer'],
      texts: ['reviewer', 'Reviews code from the project'],
      empty: undefined,
    },
    {
      label: 'a 300-character first line followed by more lines',
      offers: [
        {
          agent: 'long-winded',
          description: `${LINE_300}\nSecond line that the summary leaves out`,
          source: 'plugin',
          isOffered: true,
        },
      ],
      results: [{ isOffered: true }],
      rows: ['row:long-winded'],
      texts: ['long-winded', SUMMARY_160],
      empty: undefined,
    },
    {
      label: 'an empty description',
      offers: [{ agent: 'quiet', description: '', source: 'plugin', isOffered: true }],
      results: [{ isOffered: true }],
      rows: ['row:quiet'],
      texts: ['quiet'],
      empty: undefined,
    },
    {
      label: 'every offered type answered false',
      offers: [
        { agent: 'Explore', description: 'Explores the codebase', source: 'built-in', isOffered: false },
        { agent: 'Plan', description: 'Plans the implementation', source: 'built-in', isOffered: false },
      ],
      results: [{ isOffered: false }, { isOffered: false }],
      rows: [],
      texts: [OFFERED_EMPTY],
      empty: OFFERED_EMPTY,
    },
  ]

  for (const row of LIST_CASES) {
    test(`the pane lists each offered type by the latest answer beneath it: ${row.label}`, async ($, on) => {
      answerUnassertedOps(on)
      answerOffersInOrder(on, row.offers)

      const results = await raiseInOrder($, row.offers)

      expect(results).toEqual(row.results)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await rowKeys(ui)).toEqual(row.rows)
        expect(await shownTexts(ui)).toEqual(row.texts)
        expect(await textOf(ui, 'empty')).toBe(row.empty)
        await ui.unmount()
      }
    })
  }

  const NAMES_27 = [
    'agent-01', 'agent-02', 'agent-03', 'agent-04', 'agent-05', 'agent-06', 'agent-07', 'agent-08', 'agent-09',
    'agent-10', 'agent-11', 'agent-12', 'agent-13', 'agent-14', 'agent-15', 'agent-16', 'agent-17', 'agent-18',
    'agent-19', 'agent-20', 'agent-21', 'agent-22', 'agent-23', 'agent-24', 'agent-25', 'agent-26', 'agent-27',
  ] as const
  const ROW_KEYS_27 = [
    'row:agent-01', 'row:agent-02', 'row:agent-03', 'row:agent-04', 'row:agent-05', 'row:agent-06',
    'row:agent-07', 'row:agent-08', 'row:agent-09', 'row:agent-10', 'row:agent-11', 'row:agent-12',
    'row:agent-13', 'row:agent-14', 'row:agent-15', 'row:agent-16', 'row:agent-17', 'row:agent-18',
    'row:agent-19', 'row:agent-20', 'row:agent-21', 'row:agent-22', 'row:agent-23', 'row:agent-24',
    'row:agent-25', 'row:agent-26', 'row:agent-27',
  ]

  test('27 types offered at once, then offered again, show once each', { plugins: [CATALOG_READER] }, async ($, on) => {
    answerUnassertedOps(on)
    on('agent.offer', () => ({ isOffered: true }))

    await Promise.all(NAMES_27.map(name => $.agent.offer(offerOf(name, 'Runs one numbered task'))))
    const firstWave = await mountPane($, 'terminal')
    expect(await rowKeys(firstWave)).toEqual(ROW_KEYS_27)
    await firstWave.unmount()
    const versionAfterFirstWave = await catalogVersion($)
    expect(versionAfterFirstWave).not.toBe('0')

    await Promise.all(NAMES_27.map(name => $.agent.offer(offerOf(name, 'Runs one numbered task'))))
    const secondWave = await mountPane($, 'terminal')
    expect(await rowKeys(secondWave)).toEqual(ROW_KEYS_27)
    expect(await catalogVersion($)).toBe(versionAfterFirstWave)
  })
})

describe('slice 2: start an agent from its row', () => {
  const START_CASES = [
    { surface: 'terminal', name: 'Explore', start: 'start:Explore', status: 'status:Explore' },
    { surface: 'desktop', name: 'Plan', start: 'start:Plan', status: 'status:Plan' },
  ] as const

  test('Start spawns the pressed type with the fixed prompt and shows started', async ($, on) => {
    answerUnassertedOps(on)
    on('agent.offer', () => ({ isOffered: true }))
    const spawned: { subagent_type: unknown; prompt: string; description: string }[] = []
    on('agent.spawn', (_$, e) => {
      // The kit hands the mod's spawn to the hook beneath in the Agent tool's shape.
      const input = e as unknown as Record<string, unknown>
      spawned.push({ subagent_type: input.subagent_type, prompt: e.prompt, description: e.description })

      return STARTED
    })
    await $.agent.offer(offerOf('Explore', 'Explores the codebase'))
    await $.agent.offer(offerOf('Plan', 'Plans the implementation'))

    for (const row of START_CASES) {
      const ui = await mountPane($, row.surface)
      expect(await ui.find({ key: row.start })).toBeDefined()
      await ui.press({ key: row.start })
      expect(spawned.at(-1)).toEqual({
        subagent_type: row.name,
        prompt: expect.stringMatching(/\S/),
        description: SPAWN_DESCRIPTION,
      })
      expect(await textOf(ui, row.status)).toBe('started')
      await ui.unmount()
    }
  })

  const FAILED_START_CASES: readonly { label: string; answer: () => AgentSpawnResult; status: string }[] = [
    {
      label: '{ deny }',
      answer: () => ({ deny: 'a policy plugin refuses Explore' }),
      status: 'failed: a policy plugin refuses Explore',
    },
    {
      // A hook of the test that throws is skipped, so the kit's bottom hook
      // rejects the spawn with its own message.
      label: 'a rejection',
      answer: () => {
        throw new Error('the spawn hook beneath crashed')
      },
      status: 'failed: no implementation for agent.spawn',
    },
  ]

  for (const row of FAILED_START_CASES) {
    test(`a refused or failed start shows its reason and other rows still start: ${row.label}`, async ($, on) => {
      answerUnassertedOps(on)
      on('agent.offer', () => ({ isOffered: true }))
      const answers = [row.answer, () => STARTED]
      const spawnedTypes: unknown[] = []
      on('agent.spawn', (_$, e) => {
        spawnedTypes.push(spawnedType(e))

        return (answers.shift() ?? (() => STARTED))()
      })
      await $.agent.offer(offerOf('Explore', 'Explores the codebase'))
      await $.agent.offer(offerOf('Plan', 'Plans the implementation'))
      const ui = await mountPane($, 'terminal')
      expect(await ui.find({ key: 'start:Explore' })).toBeDefined()

      await ui.press({ key: 'start:Explore' })

      expect(await textOf(ui, 'status:Explore')).toBe(row.status)
      await ui.press({ key: 'start:Plan' })
      expect(spawnedTypes).toEqual(['Explore', 'Plan'])
    })
  }

  test('two fast presses on one row start exactly one agent', async ($, on) => {
    answerUnassertedOps(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('agent.offer', () => ({ isOffered: true }))
    let markReached = () => {}
    const reached = new Promise<void>(resolve => {
      markReached = resolve
    })
    let release = () => {}
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    const holdFirstSpawn = [released]
    const spawnedTypes: unknown[] = []
    on('agent.spawn', async (_$, e) => {
      spawnedTypes.push(spawnedType(e))
      markReached()
      await holdFirstSpawn.shift()

      return STARTED
    })
    await runAgentPane($)
    await $.agent.offer(offerOf('Explore', 'Explores the codebase'))
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ key: 'start:Explore' })).toBeDefined()

    const firstPress = ui.press({ key: 'start:Explore' })
    await reached
    await ui.press({ key: 'start:Explore' })

    expect(await textOf(ui, 'status:Explore')).toBe('starting')
    release()
    await firstPress
    expect(spawnedTypes).toEqual(['Explore'])
  })
})

describe('slice 3: list custom agent types before the first prompt', () => {
  const USAGE_CASES: readonly {
    label: string
    answer: OpEventResult<'session.usage'>
    rows: readonly string[]
    texts: readonly string[]
    note: string | undefined
    empty: string | undefined
  }[] = [
    {
      label: 'two agents',
      answer: usageAnswer({
        breakdown: {
          agents: [
            { agentType: 'clean-code-architect', source: 'userSettings', tokens: 78 },
            { agentType: 'team:code-reviewer', source: 'plugin', tokens: 87 },
          ],
        },
      }),
      rows: ['row:clean-code-architect', 'row:team:code-reviewer'],
      texts: [NOTE, 'clean-code-architect', 'team:code-reviewer'],
      note: NOTE,
      empty: undefined,
    },
    {
      label: 'an empty agents list',
      answer: usageAnswer({ breakdown: { agents: [] } }),
      rows: [],
      texts: [FIRST_PROMPT_EMPTY],
      note: undefined,
      empty: FIRST_PROMPT_EMPTY,
    },
    {
      label: 'a rejection',
      answer: { deny: 'the context breakdown is unavailable' },
      rows: [],
      texts: [FIRST_PROMPT_EMPTY],
      note: undefined,
      empty: FIRST_PROMPT_EMPTY,
    },
    {
      label: 'no context.breakdown.agents array',
      answer: usageAnswer({}),
      rows: [],
      texts: [FIRST_PROMPT_EMPTY],
      note: undefined,
      empty: FIRST_PROMPT_EMPTY,
    },
    {
      label: 'entries with a missing, empty, or non-string agentType',
      answer: usageAnswer({
        breakdown: {
          agents: [
            { agentType: 'clean-code-architect', source: 'userSettings', tokens: 78 },
            { source: 'plugin', tokens: 12 },
            { agentType: '', source: 'plugin', tokens: 12 },
            { agentType: 42, source: 'plugin', tokens: 12 },
            { agentType: 'team:code-reviewer', source: 'plugin', tokens: 87 },
          ],
        },
      }),
      rows: ['row:clean-code-architect', 'row:team:code-reviewer'],
      texts: [NOTE, 'clean-code-architect', 'team:code-reviewer'],
      note: NOTE,
      empty: undefined,
    },
  ]

  for (const row of USAGE_CASES) {
    test(`before any offer the pane lists custom types from the usage breakdown: ${row.label}`, async ($, on) => {
      answerUnassertedOps(on)
      on('session.usage', () => row.answer)

      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await rowKeys(ui)).toEqual(row.rows)
        expect(await shownTexts(ui)).toEqual(row.texts)
        expect(await textOf(ui, 'note')).toBe(row.note)
        expect(await textOf(ui, 'empty')).toBe(row.empty)
        await ui.unmount()
      }
    })
  }

  const LISTED_CASES: readonly {
    label: string
    offers: readonly OfferRow[]
    rows: readonly string[]
    texts: readonly string[]
  }[] = [
    {
      label: 'some offers answered true',
      offers: [
        { agent: 'Explore', description: 'Explores the codebase', source: 'built-in', isOffered: true },
        { agent: 'team:hidden', description: 'Hidden by a hook beneath', source: 'plugin', isOffered: false },
      ],
      rows: ['row:Explore'],
      texts: ['Explore', 'Explores the codebase'],
    },
    {
      label: 'every offer answered false',
      offers: [
        { agent: 'Explore', description: 'Explores the codebase', source: 'built-in', isOffered: false },
        { agent: 'team:hidden', description: 'Hidden by a hook beneath', source: 'plugin', isOffered: false },
      ],
      rows: [],
      texts: [OFFERED_EMPTY],
    },
  ]

  for (const row of LISTED_CASES) {
    test(`once offers arrive the pane drops the usage rows: ${row.label}`, async ($, on) => {
      answerUnassertedOps(on)
      on('session.usage', () =>
        usageAnswer({ breakdown: { agents: [{ agentType: 'team:hidden', source: 'plugin', tokens: 40 }] } }),
      )
      answerOffersInOrder(on, row.offers)

      await raiseInOrder($, row.offers)

      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await rowKeys(ui)).toEqual(row.rows)
        expect(await shownTexts(ui)).toEqual(row.texts)
        expect(await textOf(ui, 'note')).toBeUndefined()
        await ui.unmount()
      }
    })
  }
})
