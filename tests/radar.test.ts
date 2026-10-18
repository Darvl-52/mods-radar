import { expect, test } from 'claude-code/testing'

import { failuresOf, findConflicts, healthOf, matches, nameOf } from '../hooks/register'
import type { Link } from '../hooks/register'

const link = (index: number, plugin: string, outcome: Link['outcome'], received: unknown = { a: 1 }, reason?: string): Link => ({
  index,
  plugin,
  outcome,
  received,
  reason,
})

test('patterns match the way on() selects', () => {
  expect(matches('*', 'tool.call')).toBe(true)
  expect(matches('tool.*', 'tool.call')).toBe(true)
  expect(matches('!ui.*', 'tool.call')).toBe(true)
  expect(matches('!tool.*', 'tool.call')).toBe(false)
  expect(matches('tool.call', 'tool.result')).toBe(false)
})

test('a module path names its plugin', () => {
  expect(nameOf('rules-watchdog')).toBe('rules-watchdog')
  expect(nameOf('rules-watchdog@rules-watchdog')).toBe('rules-watchdog')
  expect(nameOf('/Users/x/.claude/plugins/cache/rules-watchdog/rules-watchdog/0.3.0/hooks/register.ts')).toBe('rules-watchdog')
  expect(nameOf('/Users/x/.claude/dev-mods/abc/mcp-squeeze/hooks/register.tsx')).toBe('mcp-squeeze')
})

test('an answer that stops the chain shadows whoever was seen running on that call beneath', () => {
  const links = [link(1, 'watchdog', 'returned')]
  const chain = ['mods-radar', 'watchdog', 'lens', 'bar']
  const ranOn = { lens: new Set(['tool.call Edit']), bar: new Set(['ui.render']) }
  expect(findConflicts('tool.call Edit', links, chain, ranOn)).toEqual([
    { kind: 'shadowed', by: 'watchdog', victim: 'lens', event: 'tool.call Edit' },
  ])
})

test('a plugin whose hook only ever ran for another tool is not counted as cut off', () => {
  const chain = ['mods-radar', 'watchdog', 'lens']
  const ranOn = { lens: new Set(['tool.call Bash']) }
  expect(findConflicts('tool.call Edit', [link(1, 'watchdog', 'returned')], chain, ranOn)).toEqual([])
})

test('an answer from a plugin missing from the chain cuts off nobody', () => {
  const chain = ['mods-radar', 'lens', 'bar']
  const ranOn = { lens: new Set(['tool.call Edit']), bar: new Set(['tool.call Edit']) }
  expect(findConflicts('tool.call Edit', [link(1, 'stranger', 'returned')], chain, ranOn)).toEqual([])
})

test('a chain that reaches the engine shadows nobody, and commands are answered by design', () => {
  const chain = ['mods-radar', 'watchdog', 'lens']
  const ranOn = { lens: new Set(['tool.call Edit', 'command.run watchdog']) }
  expect(findConflicts('tool.call Edit', [link(1, 'watchdog', 'returned'), link(3, 'engine', 'returned')], chain, ranOn)).toEqual([])
  expect(findConflicts('command.run watchdog', [link(1, 'watchdog', 'returned')], chain, ranOn)).toEqual([])
})

test('a rewritten input and a bypass are reported against the plugin they hit', () => {
  const links = [
    link(1, 'squeeze', 'returned', { text: 'long' }),
    link(2, 'lens', 'returned', { text: 'short' }),
    link(3, 'bar', 'skipped', { text: 'short' }, 'bypassed by squeeze'),
    link(4, 'engine', 'returned', { text: 'short' }),
  ]
  expect(findConflicts('tool.result', links, [], {})).toEqual([
    { kind: 'bypassed', by: 'squeeze', victim: 'bar', event: 'tool.result' },
    { kind: 'rewrote', by: 'squeeze', victim: 'lens', event: 'tool.result' },
  ])
})

test('failed hooks are counted, a bypassed one is not its own failure', () => {
  const links = [link(1, 'a', 'caught'), link(2, 'b', 'skipped'), link(3, 'c', 'skipped', {}, 'bypassed by a'), link(4, 'engine', 'returned')]
  expect(failuresOf(links)).toEqual(['a', 'b'])
})

test('a plugin enabled but not loaded is red, a loaded one waits yellow until it works', () => {
  const base = { name: 'w', events: [], runs: 0, failures: 0 }
  expect(healthOf({ ...base, isExpected: true, isLoaded: false })).toBe('broken')
  expect(healthOf({ ...base, isExpected: true, isLoaded: true })).toBe('idle')
  expect(healthOf({ ...base, isExpected: true, isLoaded: true, runs: 3 })).toBe('ok')
})
