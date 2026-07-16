// Directive lift (design.md §02.1, ADR-0010).
//
// A pure, deterministic, idempotent text-to-text pass over a richmd document's
// SOURCE — the only richmd step that touches source text rather than the parsed
// Pandoc AST. It rewrites every *bareword directive fence-opener*
// (`:::kind {attrs}` — the markdown-it-container / remark-directive form) into
// Pandoc's native fenced-div opener (`::: {.kind attrs}`) BEFORE Pandoc parses,
// because Pandoc's markdown reader parses an attr-bearing bareword directive as
// a plain `Para` (starting `Str ":::kind"`), never a `Div` — so it would
// silently skip all validation (a false-green; issue #17).
//
// Fidelity rules (ADR-0010):
//   - Preserve the fence's colon count exactly (`::::stat-tile` -> `:::: {…}`,
//     never normalized to three), so nested blocks still balance.
//   - Code-aware: rewrite NOTHING Pandoc reads as verbatim code — neither inside
//     a ``` / ~~~ fenced code block nor on an indented code line (4+ leading
//     spaces, or a leading tab). This matches Pandoc's own verbatim treatment, so
//     the lift and the parse can never disagree, and directive syntax quoted as a
//     literal example is preserved. (design.md §02.1 "Failure behavior".)
//   - Leave everything else byte-for-byte identical: a bare closing `:::`, an
//     already-native `::: {.kind …}`, an attrless `:::kind` (already a Div), and
//     any prose merely containing a `:::`-like sequence mid-line.
//   - Idempotent: a native opener never matches the bareword shape, so
//     lift(lift(x)) === lift(x).
//   - Raises no errors of its own — an unrecognized line is passed through, all
//     validation judgment deferred to richmd's downstream validate phase.

// A code-fence line: optional indentation, then a run of 3+ backticks OR 3+
// tildes, then anything (an info string). Captures the indent, the run, and the
// fence character so the CommonMark "closing fence must be at least as long and
// the same character" rule can be honored. Matched against a line whose trailing
// CR (from a CRLF ending) has already been stripped, so a `\r` cannot defeat the
// end-of-line match.
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

// True if `line` is an indented code line — Pandoc reads any line whose leading
// indentation is 4+ columns as verbatim (a tab counts as 4), and richmd's own
// nested directive openers never carry that much indentation (they are indented
// only by their fence colons, 0–3 spaces). So a leading tab, or 4+ leading
// spaces, means "leave verbatim, never lift and never open a fence".
function isIndentedCode(line) {
  return /^(\t| {4,})/.test(line);
}

// A bareword directive fence-opener: optional indentation, a run of 3+ colons,
// a bareword kind token (letters/digits/hyphens/underscores) written directly
// after the colons with no space, then whitespace, then a brace-attr group
// `{ ... }` to end of line. The kind token starting with a non-brace, non-space
// character is what distinguishes this from an already-native `::: {.kind}`
// (where the colons are immediately followed by whitespace then `{`).
const BAREWORD_DIRECTIVE_RE = /^(\s*)(:{3,})([A-Za-z0-9_-]+)\s+\{(.*)\}\s*$/;

// Returns true if `line` closes a fenced code block opened by `open` (an object
// { char, len } captured from the opening fence). CommonMark: the closing fence
// must use the same character and be at least as long, and may carry no info
// string (trailing whitespace is allowed).
function closesFence(line, open) {
  const m = CODE_FENCE_RE.exec(line);
  if (!m) return false;
  const run = m[2];
  const char = run[0];
  if (char !== open.char) return false;
  if (run.length < open.len) return false;
  // A closing fence carries no info string (only optional trailing whitespace).
  if (m[3].trim() !== "") return false;
  return true;
}

export function lift(sourceText) {
  // Preserve line structure exactly (including a trailing newline or its
  // absence) by splitting on "\n" and rejoining on "\n".
  const lines = sourceText.split("\n");

  // Fenced-code-block state: null when outside a fence, else { char, len } of
  // the currently-open fence.
  let openFence = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Match against the line WITHOUT its trailing carriage return so a CRLF
    // ending cannot defeat an end-of-line-anchored match. `cr` is re-appended to
    // any rewritten line so the document's original line endings are preserved.
    const hasCr = rawLine.endsWith("\r");
    const cr = hasCr ? "\r" : "";
    const line = hasCr ? rawLine.slice(0, -1) : rawLine;

    if (openFence) {
      // Inside a fenced code block: transform nothing. Only look for the close.
      if (closesFence(line, openFence)) {
        openFence = null;
      }
      continue;
    }

    // An indented code line (4+ leading spaces or a leading tab) is verbatim to
    // Pandoc — it neither lifts nor opens a fence. Skip it entirely.
    if (isIndentedCode(line)) {
      continue;
    }

    // Outside a fence: a code-fence opener switches us into verbatim mode and is
    // itself never a directive.
    const fenceOpen = CODE_FENCE_RE.exec(line);
    if (fenceOpen) {
      openFence = { char: fenceOpen[2][0], len: fenceOpen[2].length };
      continue;
    }

    const m = BAREWORD_DIRECTIVE_RE.exec(line);
    if (m) {
      const [, indent, colons, kind, attrs] = m;
      lines[i] = `${indent}${colons} {.${kind} ${attrs}}${cr}`;
    }
  }

  return lines.join("\n");
}
