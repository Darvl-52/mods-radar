// One plugin with a hooks module, as this session has seen it.
export type Mod = {
  name: string
  version?: string
  // `<name>@<marketplace>`, `<name>@inline`, ...; known once its load was seen.
  source?: string
  // Enabled in settings and its hooks.json names a module: it should be loaded.
  isExpected: boolean
  isLoaded: boolean
  // Why the engine did not load it, when a plugin refused it.
  refused?: string
  // The event patterns it hooks, when its load was seen.
  events: string[]
  // Hook runs and `$` calls seen from it.
  runs: number
  lastAt?: number
  lastEvent?: string
  failures: number
  lastFailure?: string
}

// One way one plugin got in another's way, counted per (kind, by, victim, event).
export type Conflict = {
  key: string
  // shadowed: `by` answered without passing on, `victim` hooks the event beneath it;
  // bypassed: `by` jumped past `victim`'s tier; rewrote: `victim` got `by`'s rewritten input.
  kind: 'shadowed' | 'bypassed' | 'rewrote'
  by: string
  victim: string
  event: string
  count: number
  lastAt: number
  isNew: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mods-radar': {
      mods: Record<string, Mod>
      conflicts: Conflict[]
      // The chain's modules, outermost first.
      order: string[]
      // Plugins enabled in settings with no hooks module (skills, MCP, LSP).
      others: string[]
    }
  }
}
