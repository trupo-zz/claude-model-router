// routereval/normalize.js
//
// Output normalization shared by the eval harness (routereval/run.js) and the
// runtime cascade (../cascade/run.js). Extracted 2026-09-01 so the cascade
// reuses these exact rules instead of reimplementing them -- if grading and
// runtime checking normalized differently, an eval result would stop
// predicting real behavior, which defeats the point of having the eval.
//
// routereval owns these primitives (alongside graders.js) because they were
// written and unit-tested here first. The dependency direction is deliberate:
// cascade depends on routereval, never the reverse.

// Local models habitually wrap output in markdown fences even when told not
// to. Stripping them is fair normalization, not leniency -- the fence is a
// presentation artifact, and a caller piping this output would strip it too.
// Anything beyond this (trimming prose, picking the "best" line) WOULD be
// leniency and is deliberately not done.
function stripFences(text) {
  if (typeof text !== 'string') return '';
  const fenced = text.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

// Strips ONE pair of matching quotes that wraps the entire output.
//
// FULL DISCLOSURE, because changing a normalizer after seeing a failure is an
// eval anti-pattern and must not happen silently: this was added 2026-08-31
// *after* the first sweep, in response to `commit-message` scoring 0/3 on both
// local tiers. The models emitted a structurally correct conventional commit --
// "Fix: Null Pointer Crash in Login Handler" -- wrapped in quotes, which no
// ^-anchored pattern can match.
//
// Justification for calling it normalization rather than leniency: a fully
// enclosing quote pair is a presentation wrapper of the same class as the
// markdown fence above, and routereval scores both ways (--strict) so the
// looser number can never quietly replace the stricter one. It fires only when
// the FIRST and LAST characters are the same quote mark, so an interior quote
// is never touched.
//
// It did NOT make the original finding go away: "commit message" was removed
// from the hard-deny tier anyway, because output that needs unwrapping before
// it can be piped into `git commit -m` is still a real instruction-following
// miss.
function stripWrappingQuotes(text) {
  if (typeof text !== 'string' || text.length < 2) return text;
  const t = text.trim();
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === '"' || first === "'" || first === '`') && last === first) {
    return t.slice(1, -1).trim();
  }
  return t;
}

// The standard pipeline both callers use.
function normalize(text, { strict = false } = {}) {
  const stripped = stripFences(text);
  return strict ? stripped : stripWrappingQuotes(stripped);
}

module.exports = { stripFences, stripWrappingQuotes, normalize };
