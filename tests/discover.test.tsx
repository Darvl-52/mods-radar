import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

const HOME = '/home/me'
const CACHE = `${HOME}/.claude/plugins/cache`
const FILES: Record<string, string> = {
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    version: 2,
    plugins: {
      'rules-watchdog@rules-watchdog': [{ installPath: `${CACHE}/rules-watchdog/rules-watchdog/0.3.0`, version: '0.3.0' }],
      'mattpocock-skills@official': [{ installPath: `${CACHE}/official/mattpocock-skills/1.3.1`, version: '1.3.1' }],
      'old-hooks@market': [{ installPath: `${CACHE}/market/old-hooks/1.0.0`, version: '1.0.0' }],
      'switched-off@market': [{ installPath: `${CACHE}/market/switched-off/1.0.0`, version: '1.0.0' }],
    },
  }),
  [`${CACHE}/rules-watchdog/rules-watchdog/0.3.0/hooks/hooks.json`]: '{ "modules": ["./register.ts"] }',
  // Shell hooks of the settings kind: no module to load.
  [`${CACHE}/market/old-hooks/1.0.0/hooks/hooks.json`]: '{ "hooks": { "Stop": [] } }',
  [`${CACHE}/market/switched-off/1.0.0/hooks/hooks.json`]: '{ "modules": ["./register.ts"] }',
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'mods-radar',
  props: { title: 'Моды', isFocused: true, bodyColumns: 140, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

// A stand-in for the real watchdog: it reads a variable on every edit, as the real one does.
const WATCHDOG: Plugin = {
  name: 'rules-watchdog',
  register: on => {
    on('tool.call', async ($, e, next) => {
      await $.env.get('HOME')
      return next(e)
    })
  },
}

const start = async ($: Engine, on: On, enabled: Record<string, boolean> = {}) => {
  const clock = mock.clock(on)
  on('settings.read', () => ({
    value: {
      enabledPlugins: {
        'rules-watchdog@rules-watchdog': true,
        'mattpocock-skills@official': true,
        'old-hooks@market': true,
        'switched-off@market': false,
        ...enabled,
      },
    },
  }))
  on('env.get', () => ({ value: HOME }))
  on('fs.read', ($, e) => (e.path in FILES ? { value: FILES[e.path] ?? '' } : { deny: `ENOENT ${e.path}` }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('tool.call', () => ({ result: { type: 'update' as const, filePath: '/a.ts', content: '', structuredPatch: [], originalFile: null } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return clock
}

// The plugin's row in the /mods pane.
const chip = async ($: Engine, name: string) => {
  const pane = await $.ui.mount({ plugin: 'mods-radar', surface: 'terminal', ...PANE })
  const found = await pane.find({ type: 'Text', text: new RegExp(`^● ${name}( |$)`) })
  await pane.unmount()
  return found
}

test('a plugin enabled with a hooks module that never loaded reads red: enabled, not loaded', async ($, on) => {
  await start($, on)

  expect((await chip($, 'rules-watchdog'))?.props.color).toBe('error')
  // Skills, shell hooks and a switched-off plugin are not modules to wait for.
  expect(await chip($, 'mattpocock-skills')).toBeUndefined()
  expect(await chip($, 'old-hooks')).toBeUndefined()
  expect(await chip($, 'switched-off')).toBeUndefined()

  const run = await $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 140 } })
  expect(run.text).toBe('Моды: панель открыта.')
  const pane = await $.ui.mount({ plugin: 'mods-radar', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /rules-watchdog 0\.3\.0 — включён, но не загружен/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Без хуков \(скиллы, MCP, LSP\): mattpocock-skills, old-hooks/ })).toBeDefined()
  await pane.unmount()
})

test('the loaded watchdog turns green once it is seen working on an edit', { plugins: [WATCHDOG] }, async ($, on) => {
  const clock = await start($, on)

  expect((await chip($, 'rules-watchdog'))?.props.color).toBe('warning')
  await $.tool.call({ tool: 'Write', file_path: '/a.ts', content: 'x' })
  await clock.advance(1_000)
  expect((await chip($, 'rules-watchdog'))?.props.color).toBe('success')
})

test('a /clear looks at the settings again', async ($, on) => {
  const enabled: Record<string, boolean> = {}
  await start($, on, enabled)
  expect(await chip($, 'switched-off')).toBeUndefined()

  enabled['switched-off@market'] = true
  await $.classic.SessionStart({ source: 'clear' })
  expect((await chip($, 'switched-off'))?.props.color).toBe('error')
})
