import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagents-panel',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Subagents',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('lists subagents, shows progress, and toggles sections on every surface', async ($, on) => {
  // The engine beneath the plugin: spawns answer with ids, tools answer plainly.
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-${++n}` }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.agent.spawn({ prompt: 'Review the auth flow', description: 'auth review', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'Write tests', description: 'test writer', subagentType: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'src/auth/session.ts', agentId: 'agent-1' } as never)
  await $.turn.complete({ answer: 'All tests pass.', durationMs: 10, isAborted: false, turnId: 't', agentId: 'agent-2', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Overview: both sections, each row, and the running agent's one-line summary.
    expect((await ui.find({ key: 'toggle-active' }))?.props.label).toBe('▾ In progress · 1')
    expect((await ui.find({ key: 'toggle-done' }))?.props.label).toBe('▾ Completed · 1')
    expect(await ui.find({ key: 'open-agent-1' })).toBeDefined()
    // Avatars: SVG on graphical surfaces, a colored glyph on the terminal (never an Svg it cannot draw).
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      // One glyph from the avatar families, in a color of its own.
      const glyph = await ui.find({ type: 'Text', text: /^[✦✶✷✸✹✿❀❁✾❃❂✪✺◆◈❖❋✱✲❊❉◉◎⊛✧◇✥●✽✻✼]$/u })
      expect(glyph).toBeDefined()
      expect(String(glyph?.props.color)).toMatch(/^#[0-9a-f]{6}$/)
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
    }
    // The running row's activity line is plain text: only the title opens the agent.
    expect(await ui.find({ type: 'Text', text: /Read auth\/session\.ts/ })).toBeDefined()
    expect(await ui.find({ key: 'open-line-agent-1' })).toBeUndefined()
    expect(await ui.find({ key: 'open-time-agent-1' })).toBeUndefined()

    // Hiding a section hides its rows; showing it brings them back.
    await ui.press({ key: 'toggle-done' })
    expect(await ui.find({ key: 'open-agent-2' })).toBeUndefined()
    await ui.press({ key: 'toggle-done' })
    expect(await ui.find({ key: 'open-agent-2' })).toBeDefined()

    // Detail: the agent's progress, then back to the overview.
    await ui.press({ key: 'open-agent-1' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read auth\/session\.ts/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'toggle-active' })).toBeDefined()

    await ui.unmount()
  }
})

test('rebuilds the list from the transcript when a session is resumed', async ($, on) => {
  mock.clock(on)
  mock.store(on, { 'times:s1': { 'agent-9': { s: 1000, e: 61000, p: 'completed', m: 'haiku' } } })
  on('session.id', () => ({ value: 's1' }))
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('session.messages', ($, e) => {
    if (e.agentId === 'agent-9') {
      return { value: [
        { role: 'assistant', text: 'Looking at the session code.', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'src/a/b.ts' }, text: 'ok' }] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: 'SubagentHandback', input: { report: 'The session code is fine.' }, text: 'delivered' }] },
      ] }
    }
    return { value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 't1', tool: 'Agent', input: { description: 'check sessions', subagent_type: 'Explore', prompt: 'Check it' }, text: 'done', agentId: 'agent-9' }],
      },
    ] }
  })

  await $.classic.SessionStart({ source: 'resume' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle-done' }))?.props.label).toBe('▾ Completed · 1')
    expect(await ui.find({ key: 'open-agent-9' })).toBeDefined()

    await ui.press({ key: 'open-agent-9' })
    expect(await ui.find({ type: 'Text', text: /Ran for 1m 0s/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /The session code is fine/ })).toBeDefined()
    // The hand-back is the report, not a step of the agent's work.
    expect(await ui.find({ type: 'Text', text: /SubagentHandback/ })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('the search box filters the overview on every surface that has one', async ($, on) => {
  const clock = mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-${++n}` }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.agent.spawn({ prompt: 'Review the auth flow', description: 'auth review', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'Write tests', description: 'test writer', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ answer: 'All tests pass.', durationMs: 10, isAborted: false, turnId: 't', agentId: 'agent-2', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Typing is what filters: no Enter label on the terminal; a desktop keeps its word, as it would
    // draw a blank button for an empty one.
    expect((await ui.find({ key: 'search' }))?.props.submitLabel).toBe(surface === 'terminal' ? '' : 'filter')

    // Nothing filters until the typing pauses.
    await ui.input({ key: 'search', text: 'AUTH', kind: 'change' })
    expect(await ui.find({ key: 'open-agent-2' })).toBeDefined()
    await clock.advance(200) // the filter waits a beat after typing
    expect(await ui.find({ key: 'open-agent-1' })).toBeDefined()
    expect(await ui.find({ key: 'open-agent-2' })).toBeUndefined()

    // Matches the report too, not only the name.
    await ui.input({ key: 'search', text: 'tests pass', kind: 'change' })
    await clock.advance(200) // the filter waits a beat after typing
    expect(await ui.find({ key: 'open-agent-1' })).toBeUndefined()
    expect(await ui.find({ key: 'open-agent-2' })).toBeDefined()

    await ui.input({ key: 'search', text: 'nothing like this', kind: 'change' })
    await clock.advance(200) // the filter waits a beat after typing
    expect(await ui.find({ type: 'Text', text: /No subagents match/ })).toBeDefined()

    await ui.press({ key: 'clear-search' })
    expect(await ui.find({ key: 'open-agent-1' })).toBeDefined()
    expect(await ui.find({ key: 'open-agent-2' })).toBeDefined()
    await ui.unmount()
  }
})

test('after a resume, an agent whose transcript cannot be read still shows its report and why', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 's2' }))
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('session.messages', ($, e) => {
    if (e.agentId === 'agent-7') return { value: { deny: 'agent-7: no transcript on disk' } }
    return { value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [{
          tool_use_id: 't7',
          tool: 'Agent',
          input: { description: 'count lines', subagent_type: 'general-purpose', prompt: 'Count them' },
          result: { status: 'async_launched', agentId: 'agent-7', resolvedModel: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Async agent launched successfully.' }] },
          text: 'launched',
        }],
      },
      {
        role: 'user',
        text: 'Another Claude session sent a message:\n<agent-message from="agent-7">\n[Subagent hand-back] The report follows:\n  register.tsx is 454 lines.\n</agent-message>',
        toolUses: [],
      },
    ] }
  })

  await $.classic.SessionStart({ source: 'resume' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-agent-7' })
    // The report comes from the hand-back in main; the launch notice is never mistaken for it.
    expect(await ui.find({ type: 'Markdown', text: /register\.tsx is 454 lines/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /launched successfully/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /no transcript on disk/ })).toBeDefined()
    // The launch record names the model even when nothing else does.
    expect(await ui.find({ type: 'Text', text: /claude-haiku-5-5/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('switching views hands the focus to an element of the new view', async ($, on) => {
  // The kit has no surface beneath a focus move made from a press, so this checks the hand-off is
  // asked for the right element (the trace says so); the real surface is what applies it.
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  await $.agent.spawn({ prompt: 'Review it', description: 'review', subagentType: 'Explore' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-agent-1' })
    await ui.press({ key: 'back' })
    const debug = (await $.command.run({ command: 'subagents', args: 'debug' } as never)) as { text?: string }
    expect(debug.text).toContain('hand focus -> back')
    expect(debug.text).toContain('hand focus -> open-agent-1')
    await ui.unmount()
  }
})

test('avatars are seeded by the agent id: stable per agent, varied across agents', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-seed-${++n}` }))
  for (let i = 0; i < 24; i++) await $.agent.spawn({ prompt: 'x', description: `agent ${i}`, subagentType: 'Explore' } as never)

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = (await first.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'Agent avatar').map(s => String(s.props.source))
  await first.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs2 = (await again.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'Agent avatar').map(s => String(s.props.source))
  await again.unmount()

  expect(svgs.length).toBe(24)
  expect(svgs2).toEqual(svgs)
  // Several shape families show up across 24 agents, not one star in eight colors.
  const families = new Set(svgs.map(s => /<g transform="[^"]*"><([a-z]+)/.exec(s)?.[1] ?? 'none'))
  expect(families.size).toBeGreaterThan(2)
  expect(new Set(svgs).size).toBe(24)
})

test('the terminal search border lights up while the field holds the focus', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('ui.focus', () => ({}))
  await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'Explore' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const searchBox = async () => (await ui.findAll({ type: 'Box' })).find(b => b.props.borderStyle === 'round')
  expect((await searchBox())?.props.borderDimColor).toBe(true)

  await $.ui.focus({ requestId: 'subagents', key: 'search' } as never)
  await ui.redraw()
  expect((await searchBox())?.props.borderColor).toBe('text')

  await $.ui.focus({ requestId: 'subagents', key: 'toggle-active' } as never)
  await ui.redraw()
  expect((await searchBox())?.props.borderDimColor).toBe(true)
  await ui.unmount()
})

test('the desktop band above the prompt sums up the subagents and opens the panel', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-${++n}` }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  await $.agent.spawn({ prompt: 'x', description: 'first', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'y', description: 'second', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't', agentId: 'agent-2', reason: 'answer' })
  opened.length = 0 // the first spawn opened the panel by itself

  const band = await $.ui.mount({
    plugin: 'subagents-panel',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as never)
  expect(await band.find({ type: 'Text', text: /1 subagent running/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  await band.press({ key: 'open-subagents' })
  expect(opened).toContain('subagents')
  await band.unmount()
})

test('the detail header leaves out the default agent type', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-gp' }))
  await $.agent.spawn({ prompt: 'x', description: 'plain one', subagentType: 'general-purpose' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-agent-gp' })
    expect(await ui.find({ type: 'Text', text: /general-purpose/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^sonnet$/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('the desktop band can be closed, says how to bring it back, and /subagents restores it', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // Beneath the plugin: the engine's own band, which a hidden subagents band hands back to.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.agent.spawn({ prompt: 'x', description: 'first', subagentType: 'Explore' } as never)

  const BAND = {
    plugin: 'subagents-panel',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as never

  const band = await $.ui.mount(BAND)
  // The close mark is a dismiss button, with the way back revealed on hover.
  expect((await band.find({ key: 'dismiss-band' }))?.props.role).toBe('dismiss')
  expect(await band.find({ type: 'Text', text: /Type \/subagents to bring it back/ })).toBeDefined()
  // (The toast it raises from the press reaches no surface in the kit, so it is not checked here.)
  await band.press({ key: 'dismiss-band' })
  expect(await band.find({ key: 'open-subagents' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await band.unmount()

  await $.command.run({ command: 'subagents', args: '' } as never)
  const back = await $.ui.mount(BAND)
  expect(await back.find({ key: 'open-subagents' })).toBeDefined()
  await back.unmount()
})

test('elapsed times tick on the surface itself, with no event from the engine', async ($, on) => {
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('agent.list', () => ({ value: [] }))
  await clock.advance(1000) // a start time of 0 reads as unknown
  await $.agent.spawn({ prompt: 'x', description: 'long one', subagentType: 'Explore' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-agent-1' })
    const text = async () => JSON.stringify(await ui.drawn({ in: 'elapsed-detail' }))
    expect(await text()).toMatch(/Running for /)
    const before = await text()
    // Only the surface's frame clock moves: no engine event, no redraw from the hooks module.
    await ui.advance(3000)
    const after = await text()
    expect(after).not.toBe(before)
    expect(after).toMatch(/3s/)
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('the band shows on the terminal too: glyph avatars, counts, open and close', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.agent.spawn({ prompt: 'x', description: 'first', subagentType: 'Explore' } as never)
  opened.length = 0

  const band = await $.ui.mount({
    plugin: 'subagents-panel',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as never)
  expect(await band.find({ type: 'Svg' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /1 subagent running/ })).toBeDefined()
  // The hint is a floating card (absolute, revealed on hover), not text in the line's flow.
  const card = (await band.findAll({ type: 'Box' })).find(b => b.props.position === 'absolute')
  expect(card?.props.display).toBe('none')
  await band.press({ key: 'open-subagents' })
  expect(opened).toContain('subagents')
  await band.press({ key: 'dismiss-band' })
  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await band.unmount()
})

test('a tool group header keeps its marks beside the label and wraps only when out of room', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await $.agent.spawn({ prompt: 'x', description: 'busy', subagentType: 'Explore' } as never)
  for (const tool of ['Read', 'Edit', 'Bash', 'Grep'])
    await $.tool.call({ tool, agentId: 'agent-1', file_path: 'a/b.ts', command: 'ls', pattern: 'p' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-agent-1' })
    // One row that the surface wraps: neither the label nor the marks are pushed to a line of
    // their own by an estimate, and neither shrinks.
    const row = (await ui.findAll({ type: 'Box' })).find(b => b.props.flexWrap === 'wrap')
    expect(row).toBeDefined()
    const unshrinking = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexShrink === 0)
    expect(unshrinking.length).toBeGreaterThanOrEqual(2)
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a turn that ends while the engine still runs the agent keeps it in progress', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  let status = 'waiting'
  on('agent.list', () => ({ value: [{ id: 'agent-1', description: 'slow', type: 'Explore', status }] as never }))
  await $.agent.spawn({ prompt: 'x', description: 'slow one', subagentType: 'Explore' } as never)

  // The agent stops to wait on a background command of its own: its turn ends, it is not done.
  await $.turn.complete({ answer: 'Waiting for the timer.', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'toggle-active' }))?.props.label).toBe('▾ In progress · 1')
    await ui.unmount()
  }

  // Its last turn: the engine now lists it as completed.
  status = 'completed'
  await $.turn.complete({ answer: 'All done.', durationMs: 10, isAborted: false, turnId: 't2', agentId: 'agent-1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'toggle-done' }))?.props.label).toBe('▾ Completed · 1')
  await ui.unmount()
})

test('the band holds counts only, on one line, and gives way when narrow', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-${++n}` }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await $.agent.spawn({ prompt: 'x', description: 'first', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'y', description: 'second', subagentType: 'Explore' } as never)
  await $.tool.call({ tool: 'Read', agentId: 'agent-1', file_path: 'src/very/secret.ts' } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't', agentId: 'agent-2', reason: 'answer' })

  const bandAt = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
    $.ui.mount({
      plugin: 'subagents-panel',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const wide = await bandAt(surface, 120)
    // What an agent is doing belongs to the panel, not the band.
    expect(await wide.find({ type: 'Text', text: /secret\.ts/ })).toBeUndefined()
    expect(await wide.find({ type: 'Text', text: /1 done/ })).toBeDefined()
    expect((await wide.find({ key: 'open-subagents' }))?.props.label).toBe('Open subagents')
    // The hint card reads light on dark.
    const card = (await wide.findAll({ type: 'Box' })).find(b => b.props.position === 'absolute')
    expect(card?.props.backgroundColor).toBe('#2B2D31')
    await wide.unmount()

    // Narrow: the done count goes first, then the button's words; nothing wraps.
    const narrow = await bandAt(surface, 30)
    expect(await narrow.find({ type: 'Text', text: /1 done/ })).toBeUndefined()
    expect((await narrow.find({ key: 'open-subagents' }))?.props.label).toBe('Open')
    expect((await narrow.findAll({ type: 'Box' })).find(b => b.props.flexWrap === 'nowrap')).toBeDefined()
    await narrow.unmount()
  }
})

test('a crowd of running agents stacks in the band with +N instead of overflowing', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-${++n}` }))
  for (let i = 0; i < 7; i++) await $.agent.spawn({ prompt: 'x', description: `agent ${i}`, subagentType: 'Explore' } as never)

  const bandAt = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
    $.ui.mount({
      plugin: 'subagents-panel',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    } as never)

  // Wide desktop: four heads in one stacked image, and +3 for the rest.
  const desk = await bandAt('desktop', 120)
  const stack = (await desk.findAll({ type: 'Svg' })).find(s => s.props.alt === 'Agent avatars')
  expect(stack).toBeDefined()
  expect((String(stack?.props.source).match(/<g transform="translate\(/g) ?? []).length).toBeGreaterThanOrEqual(4)
  expect(await desk.find({ type: 'Text', text: '+3' })).toBeDefined()
  await desk.unmount()

  // Narrow terminal: fewer heads, a bigger +N, never all seven.
  const term = await bandAt('terminal', 50)
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: '+6' })).toBeDefined()
  await term.unmount()
})

test('a running agent takes messages from its detail view; a finished one shows no box', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'sonnet', agentId: `agent-${++n}` }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const sent: { to: string; text: string }[] = []
  let deliver = true
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text })
    return deliver ? { isDelivered: true as const } : { isDelivered: false as const, reason: 'agent is gone' }
  })
  await $.agent.spawn({ prompt: 'x', description: 'busy one', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'y', description: 'done one', subagentType: 'Explore' } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't', agentId: 'agent-2', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    sent.length = 0
    deliver = true
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-agent-1' })
    const boxText = async () => JSON.stringify(await ui.drawn({ in: 'agent-chat' }))
    // A full-width box at the foot of the view, with its hint inside it.
    expect(await boxText()).toMatch(/Message this subagent/)
    expect(await boxText()).toMatch(/↵ send/)
    expect((await ui.find({ key: 'agent-chat' }))?.props.width).toBe('100%')

    // The space bar arrives by name: it types a space, never the word.
    for (const key of ['h', 'i', 'space', 'y', 'o', 'u']) await ui.key({ key, in: 'agent-chat' })
    expect(await boxText()).toMatch(/hi you/)
    expect(await boxText()).not.toMatch(/space/)
    // A new line: "\" then Enter (a terminal sends Shift+Enter as plain Enter), and Alt+Enter.
    await ui.key({ key: '\\', in: 'agent-chat' })
    await ui.key({ key: 'return', in: 'agent-chat' })
    await ui.key({ key: 'check the tests', in: 'agent-chat' })
    await ui.key({ key: 'return', meta: true, in: 'agent-chat' })
    await ui.key({ key: 'j', ctrl: true, in: 'agent-chat' })
    await ui.key({ key: 'ok', in: 'agent-chat' })
    expect(sent).toHaveLength(0) // none of those sent anything
    expect(await boxText()).toMatch(/check the tests/)

    // Enter sends to that agent, empties the box and adds "You →" to the timeline.
    await ui.key({ key: 'return', in: 'agent-chat' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toContain('agent-1')
    expect(sent[0]?.text).toBe('hi you\ncheck the tests\n\nok')
    expect(await boxText()).not.toMatch(/check the tests/)
    expect(await ui.find({ type: 'Text', text: /check the tests/ })).toBeDefined()

    // A failed delivery hands the text back to the box.
    deliver = false
    for (const key of ['r', 'e', 't', 'r', 'y', 'space', 'm', 'e']) await ui.key({ key, in: 'agent-chat' })
    await ui.key({ key: 'return', in: 'agent-chat' })
    expect(await boxText()).toMatch(/retry me/)

    await ui.press({ key: 'back' })
    await ui.press({ key: 'open-agent-2' })
    expect(await ui.find({ key: 'agent-chat' })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('the terminal band has a rule across its top; the desktop band does not', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-1' }))
  await $.agent.spawn({ prompt: 'x', description: 'one', subagentType: 'Explore' } as never)
  const bandAt = (surface: 'terminal' | 'desktop') =>
    $.ui.mount({
      plugin: 'subagents-panel',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    } as never)
  const term = await bandAt('terminal')
  expect(await term.find({ type: 'Text', text: /^─{80}$/ })).toBeDefined()
  await term.unmount()
  const desk = await bandAt('desktop')
  expect(await desk.find({ type: 'Text', text: /^─+$/ })).toBeUndefined()
  await desk.unmount()
})
