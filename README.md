# mods-radar

**English** · [Русский](README.ru.md)

A Claude Code mod that shows which plugin hooks modules are loaded and actually working in this session, and where they get in each other's way.

You install a mod and can't tell whether it runs at all: it may be enabled but never loaded, loaded but never called, or failing quietly. And when several mods hook the same events, one can stop another from running without anyone noticing. mods-radar watches every dispatch and tells you.

The panel's text is in Russian.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mods-radar --marketplace Darvl-52/mods-radar
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install mods-radar --marketplace Darvl-52/mods-radar
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Darvl-52/mods-radar`, then Add plugin.

## Use

`/mods` opens a panel listing every plugin with a hooks module, outermost in the chain first:

- **green**: seen working in this session (its hooks ran, or it called the engine);
- **yellow**: loaded, no work seen yet;
- **red**: enabled in settings with a hooks module but not loaded, refused by another plugin, or its hooks fail.

For each one: version, how many times it ran, the last event and when, and the events it hooks. Plugins with no hooks module (skills, MCP, LSP) are listed on one line below.

## Conflicts

mods-radar reads the engine's trace of every dispatch and reports, with a toast the first time:

- **cut off**: a plugin answered an event itself, so a plugin beneath it that has run on that same call before (same event, same tool) did not run this time;
- **bypassed**: a plugin jumped past another's tier with `next.to`;
- **rewrote**: a plugin changed an event's input before another plugin saw it.

It also lists the events several plugins hook, where they may cross.

## Limits

- It sees the hooks of plugins beneath it in the chain. For plugins above it, it sees only their calls on the engine (`$`), and the panel says which plugins those are.
- A hook's matcher (`{ tool: 'Bash' }`) cannot be read from outside, so a plugin counts as cut off only on a call it was already seen running on. A plugin cut off from its very first call goes unreported.
- What each plugin ran on is kept in memory and starts over when mods-radar reloads.

## License

MIT
