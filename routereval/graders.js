// routereval/graders.js
//
// Deterministic graders for routing evals. Deliberately NOT an LLM-as-judge:
// ECC's eval-harness guidance is "deterministic > probabilistic," and using a
// model to grade whether a model is good enough to be routed to is circular.
// A model grader can be added later as a separate, clearly-labeled grader
// type -- it must never silently stand in for these.
//
// Contract: grade(spec, output) -> { pass, reason }. This function must NEVER
// throw, for any spec or any output, including malformed ones. A grader that
// throws would abort an eval run partway and silently bias the results toward
// whatever was measured before the crash.
//
// Provenance: skeleton drafted on the local `custom` tier (per the standing
// local-first preference), then reviewed and corrected here. The draft had
// four real defects, all fixed below and all called out inline: it rejected
// empty output as invalid, left `new RegExp` unguarded, miscounted words, and
// had no top-level catch.

// An empty string is a legitimate output to grade -- it should FAIL a
// `contains` check, not error out. The local draft used `if (!spec || !output)`,
// which conflates "" with a missing argument and would have scored an empty
// model response as a grader error rather than a failed task.
function normalizeOutput(output) {
  if (output === null || output === undefined) return '';
  return String(output);
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function gradeInner(spec, out) {
  if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') {
    return { pass: false, reason: 'malformed grader spec (missing .type)' };
  }

  switch (spec.type) {
    // Every listed string must appear, case-insensitively.
    case 'contains': {
      const needles = asArray(spec.value);
      const hay = out.toLowerCase();
      for (const n of needles) {
        if (typeof n !== 'string') return { pass: false, reason: `non-string needle: ${JSON.stringify(n)}` };
        if (!hay.includes(n.toLowerCase())) return { pass: false, reason: `missing required text: "${n}"` };
      }
      return { pass: true, reason: `contains all ${needles.length}` };
    }

    // No listed string may appear.
    case 'notContains': {
      const needles = asArray(spec.value);
      const hay = out.toLowerCase();
      for (const n of needles) {
        if (typeof n !== 'string') return { pass: false, reason: `non-string needle: ${JSON.stringify(n)}` };
        if (hay.includes(n.toLowerCase())) return { pass: false, reason: `contains forbidden text: "${n}"` };
      }
      return { pass: true, reason: `avoided all ${needles.length}` };
    }

    // Pattern match. new RegExp() throws on an invalid pattern -- the local
    // draft called it unguarded, which would have violated the never-throw
    // contract via a typo in a task file.
    case 'regex': {
      let re;
      try {
        re = new RegExp(spec.value, spec.flags || '');
      } catch (e) {
        return { pass: false, reason: `invalid regex in spec: ${e.message}` };
      }
      return re.test(out)
        ? { pass: true, reason: 'regex matched' }
        : { pass: false, reason: `regex did not match: /${spec.value}/${spec.flags || ''}` };
    }

    case 'json': {
      try {
        JSON.parse(out.trim());
        return { pass: true, reason: 'valid JSON' };
      } catch (e) {
        return { pass: false, reason: `invalid JSON: ${e.message}` };
      }
    }

    // The local draft used output.split(/\W+/).length, which counts empty
    // leading/trailing tokens and splits on punctuation inside words, so
    // "don't stop" scored 3. Split on whitespace and drop empties instead.
    case 'maxWords': {
      if (typeof spec.value !== 'number' || !Number.isFinite(spec.value) || spec.value < 0) {
        return { pass: false, reason: 'maxWords requires a non-negative number' };
      }
      const words = out.trim().split(/\s+/).filter(Boolean);
      return words.length <= spec.value
        ? { pass: true, reason: `${words.length} words` }
        : { pass: false, reason: `${words.length} words > limit ${spec.value}` };
    }

    case 'maxLines': {
      if (typeof spec.value !== 'number' || !Number.isFinite(spec.value) || spec.value < 0) {
        return { pass: false, reason: 'maxLines requires a non-negative number' };
      }
      const lines = out.split('\n').filter((l) => l.trim() !== '');
      return lines.length <= spec.value
        ? { pass: true, reason: `${lines.length} lines` }
        : { pass: false, reason: `${lines.length} lines > limit ${spec.value}` };
    }

    // Composite. Reports the FIRST failing sub-spec's reason so a failure is
    // actionable rather than just "composite failed".
    case 'all': {
      const subs = Array.isArray(spec.of) ? spec.of : [];
      if (subs.length === 0) return { pass: false, reason: "'all' spec has no sub-specs" };
      for (const sub of subs) {
        const r = gradeInner(sub, out);
        if (!r.pass) return { pass: false, reason: `${sub.type}: ${r.reason}` };
      }
      return { pass: true, reason: `all ${subs.length} sub-checks passed` };
    }

    default:
      return { pass: false, reason: `unknown grader type: "${spec.type}"` };
  }
}

function grade(spec, output) {
  try {
    return gradeInner(spec, normalizeOutput(output));
  } catch (e) {
    // Belt-and-braces: the contract is never-throw, so even an unforeseen
    // defect above degrades to a scored failure with a visible reason rather
    // than aborting the whole eval run.
    return { pass: false, reason: `grader error: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { grade };
