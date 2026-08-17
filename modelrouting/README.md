# modelrouting

The **static policy table** for Claude-tier routing on Agent-tool calls:
`model-routing.json` (keyword -> tier: opus/kimi/haiku/fable, default sonnet).
This file is the single source of truth for that keyword table. Nothing else
in the stack maintains a second copy -- both live hooks that consult it
(`../modelweighter/hook.js`, `../localmodel/enforce-hook.js`) `require()` this
exact file at runtime rather than embedding their own keyword lists, so the
policy can't drift out of sync between them.

**This directory does not own a live PreToolUse hook.** `enforce-model-routing.js`
is the original hook that read this table and warned on override mismatches,
but it was superseded by `../modelweighter/hook.js` on 2026-07-31 (same
matcher, same logic, plus a learned-belief layer on top) and is **not** wired
in `settings.json` anymore. It's kept in this directory for reference --
it still runs correctly stand-alone -- but confirm against `settings.json`
directly if you need to know what's actually live; don't assume from this
directory's presence alone.

See `ARCHITECTURE.md` in this directory for the full map of how
`modelrouting` / `modelweighter` / `localmodel` divide responsibility and
the actual call flow from "Claude is about to spawn an Agent" to "which
model/tier gets used."
