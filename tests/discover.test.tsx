import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

import { under } from '../hooks/register'

// Where a machine keeps its config folder and which project the session runs in. `root` is the
// project as the session reads it, `project` as the installed list spells it.
type Machine = { env: Record<string, string>; config: string; project: string; root: string; other: string }

const MACHINES: Record<string, Machine> = {
  posix: { env: { HOME: '/home/me' }, config: '/home/me/.claude', project: '/work/app', root: '/work/app', other: '/work/other' },
  // No HOME: the profile folder only, paths with `\` and a drive whose case may differ.
  windows: {
    env: { USERPROFILE: 'C:\\Users\\me' },
    config: 'C:\\Users\\me\\.claude',
    project: 'C:\\Work\\App',
    root: 'c:\\work\\app',
    other: 'C:\\Work\\Other',
  },
  // A config folder moved by CLAUDE_CONFIG_DIR: nothing under ~/.claude.
  'CLAUDE_CONFIG_DIR': {
    env: { CLAUDE_CONFIG_DIR: '/srv/claude', HOME: '/home/me' },
    config: '/srv/claude',
    project: '/work/app',
    root: '/work/app',
    other: '/work/other',
  },
}

const filesOf = (m: Machine): Record<string, string> => {
  const cache = (...parts: string[]) => under(m.config, 'plugins', 'cache', ...parts)
  return {
    [under(m.config, 'plugins', 'installed_plugins.json')]: JSON.stringify({
      version: 2,
      plugins: {
        // Installed twice: an older copy for another project, this project's own after it.
        'rules-watchdog@rules-watchdog': [
          { scope: 'local', projectPath: m.other, installPath: cache('rules-watchdog', 'rules-watchdog', '0.2.0'), version: '0.2.0' },
          { scope: 'project', projectPath: m.project, installPath: cache('rules-watchdog', 'rules-watchdog', '0.3.0'), version: '0.3.0' },
        ],
        'mattpocock-skills@official': [{ scope: 'user', installPath: cache('official', 'mattpocock-skills', '1.3.1'), version: '1.3.1' }],
        'old-hooks@market': [{ scope: 'user', installPath: cache('market', 'old-hooks', '1.0.0'), version: '1.0.0' }],
        'switched-off@market': [{ scope: 'user', installPath: cache('market', 'switched-off', '1.0.0'), version: '1.0.0' }],
      },
    }),
    [cache('rules-watchdog', 'rules-watchdog', '0.3.0', 'hooks', 'hooks.json')]: '{ "modules": ["./register.ts"] }\r\n',
    // Shell hooks of the settings kind: no module to load.
    [cache('rules-watchdog', 'rules-watchdog', '0.2.0', 'hooks', 'hooks.json')]: '{ "hooks": { "Stop": [] } }',
    [cache('market', 'old-hooks', '1.0.0', 'hooks', 'hooks.json')]: '{ "hooks": { "Stop": [] } }',
    [cache('market', 'switched-off', '1.0.0', 'hooks', 'hooks.json')]: '{ "modules": ["./register.ts"] }',
  }
}

// The engine hands a hook a path as this system spells it (`C:\home\me\...` for `/home/me/...` on
// Windows): a file is found by its parts, whatever the separator or the drive in front.
const parts = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

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

const start = async ($: Engine, on: On, machine: Machine = MACHINES.posix!, enabled: Record<string, boolean> = {}) => {
  const files = filesOf(machine)
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
  on('env.get', ($, e) => ({ value: machine.env[e.name] }))
  on('session.root', () => ({ value: machine.root }))
  on('fs.read', ($, e) => {
    const file = Object.keys(files).find(path => parts(e.path).endsWith(parts(path)))
    return file === undefined ? { deny: `ENOENT ${e.path}` } : { value: files[file] ?? '' }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('tool.call', () => ({ result: { type: 'update' as const, filePath: '/a.ts', content: '', structuredPatch: [], originalFile: null } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: machine.root, surface: 'terminal', isInteractive: true })
  return clock
}

// The plugin's row in the /mods pane.
const chip = async ($: Engine, name: string) => {
  const pane = await $.ui.mount({ plugin: 'mods-radar', surface: 'terminal', ...PANE })
  const found = await pane.find({ type: 'Text', text: new RegExp(`^● ${name}( |$)`) })
  await pane.unmount()
  return found
}

const mods = ($: Engine) =>
  $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 140 } })

for (const [os, machine] of Object.entries(MACHINES))
  test(`a plugin enabled with a hooks module that never loaded reads red: enabled, not loaded (${os})`, async ($, on) => {
    await start($, on, machine)

    expect((await chip($, 'rules-watchdog'))?.props.color).toBe('error')
    // Skills, shell hooks and a switched-off plugin are not modules to wait for.
    expect(await chip($, 'mattpocock-skills')).toBeUndefined()
    expect(await chip($, 'old-hooks')).toBeUndefined()
    expect(await chip($, 'switched-off')).toBeUndefined()

    const run = await mods($)
    expect(run.text).toBe('Моды: панель открыта.')
    const pane = await $.ui.mount({ plugin: 'mods-radar', surface: 'terminal', ...PANE })
    // This project's copy, not the other project's older one.
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
  const clock = await start($, on, MACHINES.windows!, enabled)
  expect(await chip($, 'switched-off')).toBeUndefined()

  enabled['switched-off@market'] = true
  await $.session.end({ reason: 'clear', sessionId: 'before', resume: { id: 'before' } })
  await clock.advance(1_000)
  expect((await chip($, 'switched-off'))?.props.color).toBe('error')
})

test('/mods looks at the settings again', async ($, on) => {
  const enabled: Record<string, boolean> = {}
  await start($, on, MACHINES.posix!, enabled)
  expect(await chip($, 'switched-off')).toBeUndefined()

  enabled['switched-off@market'] = true
  await mods($)
  expect((await chip($, 'switched-off'))?.props.color).toBe('error')
})
