import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TraceEntry } from 'claude-code'

import type { Conflict, Mod } from '../types'

const ME = 'mods-radar'
const PANE = 'mods-radar'
const mods = atom({ plugin: 'mods-radar', key: 'mods' } as const, {})
const conflicts = atom({ plugin: 'mods-radar', key: 'conflicts' } as const, [])
const order = atom({ plugin: 'mods-radar', key: 'order' } as const, [])
const others = atom({ plugin: 'mods-radar', key: 'others' } as const, [])

// Events the activity hook passes straight through: its own writes, timers and logging would
// otherwise count as work, and the loads are hooked by name below.
const QUIET = ['state.*', 'store.*', 'clock.*', 'telemetry.*', 'engine.create', 'plugin.register']
// Events a plugin answers by design, under a matcher this mod cannot see (a command of its own):
// an answer there cuts nobody off.
const ANSWERED = ['command.*', 'config.describe', 'tool.describe', 'skill.prompt', 'session.*']
const FAILED = new Set(['caught', 'expired', 'kept'])
const NOT_A_PLUGIN = new Set(['engine', 'client', ME])

export const matches = (pattern: string, event: string): boolean =>
  pattern.startsWith('!')
    ? !matches(pattern.slice(1), event)
    : pattern === '*' || pattern === event || (pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1)))

// A chain entry names a module by its plugin's name, or by a path inside the plugin's folder.
export const nameOf = (entry: string): string => {
  const parts = entry.split('/').filter(Boolean)
  if (parts.length < 2) return entry.replace(/@.*$/, '')
  const at = parts.lastIndexOf('hooks')
  const folder = at > 0 ? parts.slice(0, at) : parts.slice(0, -1)
  // An installed plugin sits under its version folder: cache/<market>/<name>/<version>.
  const cache = folder.lastIndexOf('cache')
  return (cache >= 0 && folder.length >= cache + 3 ? folder[cache + 2] : folder[folder.length - 1]) ?? entry
}

export type Link = Pick<TraceEntry, 'index' | 'plugin' | 'outcome' | 'reason'> & { received: unknown }
export type Finding = { kind: Conflict['kind']; by: string; victim: string; event: string }

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return true
  }
}

// What one dispatch's trace says about plugins getting in each other's way. `event` carries
// the call's subject (`tool.call Edit`); `ranOn` is what each plugin's hooks were seen running on.
export const findConflicts = (
  event: string,
  links: readonly Link[],
  chain: readonly string[],
  ranOn: Readonly<Record<string, ReadonlySet<string>>>,
): Finding[] => {
  const name = event.split(' ')[0] ?? event
  const sorted = [...links].sort((a, b) => a.index - b.index)
  const found: Finding[] = []
  for (const link of sorted) {
    const by = link.reason?.match(/^bypassed by (.+)$/)?.[1]
    if (link.outcome === 'skipped' && by !== undefined && !NOT_A_PLUGIN.has(link.plugin))
      found.push({ kind: 'bypassed', by, victim: link.plugin, event })
  }
  for (const [i, b] of sorted.entries()) {
    const a = sorted[i - 1]
    if (a === undefined || NOT_A_PLUGIN.has(a.plugin) || NOT_A_PLUGIN.has(b.plugin) || a.outcome === 'skipped') continue
    if (!same(a.received, b.received)) found.push({ kind: 'rewrote', by: a.plugin, victim: b.plugin, event })
  }
  // The trace ends short of the engine where a link answered without passing on: whoever sits
  // beneath it never ran. A hook's matcher (`{ tool: 'Bash' }`) is not to be read from outside,
  // so only a plugin already seen running on this very event and subject counts as cut off.
  const last = sorted[sorted.length - 1]
  const at = last === undefined ? -1 : chain.indexOf(last.plugin)
  if (last !== undefined && at >= 0 && last.outcome === 'returned' && !ANSWERED.some(p => matches(p, name))) {
    for (const victim of chain.slice(at + 1))
      if (victim !== ME && ranOn[victim]?.has(event)) found.push({ kind: 'shadowed', by: last.plugin, victim, event })
  }
  return found
}

export const failuresOf = (links: readonly Link[]): string[] =>
  links
    .filter(l => !NOT_A_PLUGIN.has(l.plugin) && (FAILED.has(l.outcome) || (l.outcome === 'skipped' && l.reason === undefined)))
    .map(l => l.plugin)

const blank = (name: string): Mod => ({ name, isExpected: false, isLoaded: false, events: [], runs: 0, failures: 0 })

// A value an earlier version of this mod wrote may lack fields: fill them in on read.
const shaped = (all: unknown): Record<string, Mod> => {
  const out: Record<string, Mod> = {}
  if (all === null || typeof all !== 'object') return out
  for (const [name, mod] of Object.entries(all as Record<string, Partial<Mod>>)) out[name] = { ...blank(name), ...mod }
  return out
}

export const kindWords: Record<Conflict['kind'], (c: Pick<Conflict, 'by' | 'victim' | 'event'>) => string> = {
  shadowed: c => `${c.by} ответил на ${c.event} сам, ${c.victim} не запускался`,
  bypassed: c => `${c.by} обошёл хук ${c.victim} на ${c.event}`,
  rewrote: c => `${c.by} меняет ${c.event} до того, как его видит ${c.victim}`,
}

export type Health = 'ok' | 'idle' | 'broken'
export const healthOf = (mod: Mod): Health =>
  mod.refused !== undefined || (mod.isExpected && !mod.isLoaded) || mod.failures > 0 ? 'broken' : mod.runs > 0 ? 'ok' : 'idle'
const COLOR = { ok: 'success', idle: 'warning', broken: 'error' } as const

export const statusOf = (mod: Mod): string =>
  mod.refused !== undefined
    ? `не загружен: ${mod.refused}`
    : mod.isExpected && !mod.isLoaded
      ? 'включён, но не загружен'
      : mod.failures > 0
        ? `ошибки: ${mod.failures} (${mod.lastFailure ?? '?'})`
        : mod.runs > 0
          ? 'работает'
          : 'загружен, работы ещё не видно'

const clockText = (ms: number | undefined) => (ms === undefined ? '' : new Date(ms).toTimeString().slice(0, 8))

// engine.create runs before `$` can write state: the chain waits here for session.start.
let chain: string[] = []
// Seen between flushes, merged into $.state at most once a second.
let pendingRuns: Record<string, { runs: number; failures: number; lastAt: number; lastEvent: string; lastFailure?: string }> = {}
let pendingFound: (Finding & { at: number })[] = []
let pendingLoads: Record<string, Partial<Mod>> = {}
let isFlushing = false
// What each plugin's hooks were seen running on (`tool.call Edit`), for telling who an answer cut off.
const ranOn: Record<string, Set<string>> = {}

const flush = async ($: EngineInterface) => {
  const runs = pendingRuns
  const found = pendingFound
  const loads = pendingLoads
  pendingRuns = {}
  pendingFound = []
  pendingLoads = {}
  isFlushing = false
  await update($, mods, old => {
    const all = shaped(old)
    for (const [name, load] of Object.entries(loads)) all[name] = { ...(all[name] ?? blank(name)), ...load }
    for (const [name, run] of Object.entries(runs)) {
      const mod = all[name] ?? { ...blank(name), isLoaded: true }
      all[name] = {
        ...mod,
        isLoaded: true,
        runs: mod.runs + run.runs,
        failures: mod.failures + run.failures,
        lastAt: run.lastAt,
        lastEvent: run.lastEvent,
        lastFailure: run.lastFailure ?? mod.lastFailure,
      }
    }
    return all
  })
  const fresh: string[] = []
  await update($, conflicts, old => {
    const list = Array.isArray(old) ? [...old] : []
    for (const f of found) {
      const key = `${f.kind}|${f.by}|${f.victim}|${f.event}`
      const at = list.findIndex(c => c.key === key)
      const seen = list[at]
      if (seen !== undefined) list[at] = { ...seen, count: seen.count + 1, lastAt: f.at }
      else {
        list.push({ key, ...f, count: 1, lastAt: f.at, isNew: true })
        fresh.push(kindWords[f.kind](f))
      }
    }
    return list.slice(-100)
  })
  if (fresh.length > 0) $.ui.toast(`Моды мешают друг другу: ${fresh[0]}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}. Подробности: /mods`)
}

const later = ($: EngineInterface) => {
  if (isFlushing) return
  isFlushing = true
  $.clock.after(1000, () => void flush($).catch(() => (isFlushing = false)))
}

const noteRun = (plugin: string, event: string, at: number, failure?: string) => {
  const run = (pendingRuns[plugin] ??= { runs: 0, failures: 0, lastAt: at, lastEvent: event })
  run.runs += 1
  run.lastAt = at
  run.lastEvent = event
  if (failure !== undefined) {
    run.failures += 1
    run.lastFailure = failure
  }
}

// What should be loaded: plugins enabled in settings whose hooks.json names a module.
const discover = async ($: EngineInterface) => {
  if (chain.length > 0) await update($, order, () => chain)
  const known = new Set(chain)
  const settings = (await $.settings.read()) as { enabledPlugins?: Record<string, unknown> }
  const enabled = Object.entries(settings.enabledPlugins ?? {})
    .filter(([, isOn]) => isOn === true)
    .map(([id]) => id)
  const home = await $.env.get('HOME')
  const installed = await $.fs
    .read(`${home}/.claude/plugins/installed_plugins.json`)
    .then(text => (JSON.parse(text) as { plugins?: Record<string, { installPath?: string; version?: string }[]> }).plugins ?? {})
    .catch(() => ({}) as Record<string, { installPath?: string; version?: string }[]>)
  const plain: string[] = []
  await update($, mods, old => {
    const all = shaped(old)
    for (const name of known) all[name] = { ...(all[name] ?? blank(name)), isLoaded: true }
    return all
  })
  for (const id of enabled) {
    const name = id.replace(/@.*$/, '')
    const entry = installed[id]?.[0]
    const hooksFile = await $.fs.read(`${entry?.installPath ?? '/nonexistent'}/hooks/hooks.json`).catch(() => '')
    if (!/"modules"\s*:/.test(hooksFile) && !known.has(name)) {
      plain.push(name)
      continue
    }
    await update($, mods, old => {
      const all = shaped(old)
      const mod = all[name] ?? blank(name)
      all[name] = { ...mod, isExpected: true, version: mod.version ?? entry?.version, source: mod.source ?? id }
      return all
    })
  }
  await update($, others, () => plain.sort())
}

export const register: Register = on => {
  on('engine.create', ($, e, next) => {
    // At this plugin's own reload the list holds it alone: keep the whole one from the load.
    if (e.plugins.length > 1 || chain.length === 0) chain = e.plugins.map(nameOf)
    return next(e)
  })

  on('plugin.register', async ($, e, next) => {
    const result = await next(e)
    pendingLoads[e.name] = {
      version: e.version,
      source: e.provenance,
      events: [...e.uses.events],
      isLoaded: result.refuse === undefined,
      refused: result.refuse,
    }
    if (!chain.includes(e.name)) chain = [...chain, e.name]
    return result
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mods', description: 'Какие моды работают и не мешают ли друг другу' })
    await discover($).catch(() => {})
    await flush($)
    return next(e)
  })

  // A /clear empties $.state and starts no session.start: look again.
  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    if (e.source !== 'startup') {
      await discover($).catch(() => {})
      await flush($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mods' }, async $ => {
    await flush($)
    await update($, conflicts, old => (Array.isArray(old) ? old.map(c => ({ ...c, isNew: false })) : []))
    await $.ui.open({ id: PANE, title: 'Моды' })
    return { text: 'Моды: панель открыта.' }
  })

  // Every dispatch but drawing: who raised it (a plugin's `$` call) and whose hooks ran beneath.
  on('!ui.*', async ($, e, next) => {
    const event = next.event
    if (QUIET.some(p => matches(p, event))) return next(e)
    const at = await $.clock.now()
    const subject = e !== null && typeof e === 'object' ? ((e as { tool?: unknown }).tool ?? (e as { command?: unknown }).command) : undefined
    const label = typeof subject === 'string' ? `${event} ${subject}` : event
    if (!NOT_A_PLUGIN.has(next.origin.plugin) && next.origin.tier !== 'core') noteRun(next.origin.plugin, label, at)
    try {
      return await next(e)
    } finally {
      // What was seen is the mod's business alone: a slip here never reaches the dispatch.
      try {
      const links: Link[] = next.trace.map(t => ({ index: t.index, plugin: t.plugin, outcome: t.outcome, reason: t.reason, received: t.received }))
      const failed = new Set(failuresOf(links))
      for (const link of links)
        if (!NOT_A_PLUGIN.has(link.plugin) && link.reason === undefined) {
          noteRun(link.plugin, label, at, failed.has(link.plugin) ? `${label}: ${link.outcome}` : undefined)
          ;(ranOn[link.plugin] ??= new Set()).add(label)
        }
      for (const f of findConflicts(label, links, chain, ranOn)) pendingFound.push({ ...f, at })
      later($)
      } catch {}
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = shaped(await read($, mods))
    const chained = (await read($, order)) ?? []
    const rank = (name: string) => (chained.includes(name) ? chained.indexOf(name) : chained.length)
    const rows = Object.values(all).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    const list = [...((await read($, conflicts)) ?? [])].sort((a, b) => b.lastAt - a.lastAt)
    const plain = (await read($, others)) ?? []
    const above = chained.slice(0, Math.max(0, chained.indexOf(ME)))
    const shared: [string, string[]][] = []
    for (const pattern of new Set(rows.flatMap(m => m.events))) {
      if (pattern.startsWith('!') || pattern === '*' || pattern.startsWith('ui.')) continue
      const who = rows.filter(m => m.events.includes(pattern)).map(m => m.name)
      if (who.length > 1) shared.push([pattern, who])
    }
    return (
      <Box flexDirection="column">
        <Text bold>Модули с хуками, сверху внешние</Text>
        {rows.map(m => (
          <Box key={m.name} flexDirection="column">
            <Text color={COLOR[healthOf(m)]} wrap="truncate">
              ● {m.name}
              {m.version ? ` ${m.version}` : ''} — {statusOf(m)}
            </Text>
            <Text wrap="truncate">
              {'   '}
              {m.runs} срабат.{m.lastAt !== undefined ? `, последнее ${m.lastEvent} в ${clockText(m.lastAt)}` : ''}
              {m.events.length > 0 ? ` · хуки: ${m.events.join(', ')}` : ''}
            </Text>
          </Box>
        ))}
        {above.length > 0 && (
          <Text color="warning" wrap="wrap">
            Выше {ME} в цепочке: {above.join(', ')}. Их хуки отсюда не видны, видны только их вызовы $.
          </Text>
        )}
        {plain.length > 0 && <Text wrap="wrap">Без хуков (скиллы, MCP, LSP): {plain.join(', ')}</Text>}
        <Text> </Text>
        <Text bold>Мешают друг другу</Text>
        {list.length === 0 && <Text color="success">Пока ничего не замечено.</Text>}
        {list.map(c => (
          <Text key={c.key} color={c.kind === 'rewrote' ? 'warning' : 'error'} bold={c.isNew} wrap="wrap">
            {c.isNew ? '★ ' : '⚠ '}
            {kindWords[c.kind](c)} ×{c.count}, {clockText(c.lastAt)}
          </Text>
        ))}
        {shared.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>Общие события (могут пересекаться)</Text>
            {shared.map(([pattern, who]) => (
              <Text key={pattern} wrap="truncate">
                {pattern}: {who.join(', ')}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
