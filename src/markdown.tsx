import { Fragment, type ReactNode } from "react";

/**
 * A small Markdown renderer for assistant output.
 *
 * Produces React elements directly rather than an HTML string. That's the
 * whole reason it's hand-written instead of `marked` + a sanitiser: nothing
 * here can inject markup, so arbitrary transcript text — including tool output
 * that the model never vetted — is safe to display without a sanitisation pass.
 *
 * Scope is what LLM replies actually use: fenced code, headings, rules, quotes,
 * lists, tables, and inline emphasis/code/links. Not a spec-complete parser.
 */

// ------------------------------------------------------------------ inline

const INLINE_SRC = [
  "(`+)([\\s\\S]*?)\\1", // 1,2  `code`
  "\\*\\*([\\s\\S]+?)\\*\\*", // 3    **bold**
  "__([\\s\\S]+?)__", // 4    __bold__
  "~~([\\s\\S]+?)~~", // 5    ~~strike~~
  "\\*([^*\\n]+?)\\*", // 6    *italic*
  "(?<![A-Za-z0-9_])_([^_\\n]+?)_(?![A-Za-z0-9_])", // 7  _italic_
  "\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // 8,9  [text](url)
  "(https?://[^\\s<>()\\[\\]]+)", // 10   bare url
].join("|");

/** Only http(s) and mailto get to be links; anything else renders as text. */
function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  // target=_blank routes through Electron's setWindowOpenHandler, which hands
  // the URL to the system browser instead of navigating the app away.
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function inline(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  // A FRESH regex per call, not a shared module-level one. `inline` recurses
  // (bold containing italic, a link containing code), and a /g regex carries
  // mutable `lastIndex` — a nested call would rewind the outer loop's cursor
  // and spin forever.
  const re = new RegExp(INLINE_SRC, "g");

  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    // Belt and braces against a zero-length match stalling the cursor.
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `i${key++}`;

    if (m[2] !== undefined) {
      out.push(<code key={k}>{m[2].trim()}</code>);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<strong key={k}>{inline(m[3] ?? m[4])}</strong>);
    } else if (m[5] !== undefined) {
      out.push(<del key={k}>{inline(m[5])}</del>);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(<em key={k}>{inline(m[6] ?? m[7])}</em>);
    } else if (m[9] !== undefined) {
      const href = safeHref(m[9]);
      // A rejected scheme (javascript:, data:, …) falls back to the literal
      // source text rather than a bare label, so nothing is silently dropped.
      out.push(
        href ? (
          <Link key={k} href={href}>{inline(m[8] || m[9])}</Link>
        ) : (
          <Fragment key={k}>{m[0]}</Fragment>
        ),
      );
    } else if (m[10] !== undefined) {
      out.push(<Link key={k} href={m[10]}>{m[10]}</Link>);
    }
    last = m.index + m[0].length;
  }

  if (last < src.length) out.push(src.slice(last));
  return out;
}

// ------------------------------------------------------------------ blocks

const FENCE = /^\s*(```+|~~~+)\s*(\S*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL = /^(\s*)[-*+]\s+(.*)$/;
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // --- fenced code ---
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence (or EOF — an unterminated block still renders)
      out.push(
        <pre key={k()} className="md-code">
          {lang && <span className="md-lang">{lang}</span>}
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={k()} />);
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      const Tag = `h${level}` as "h1";
      out.push(
        <Tag key={k()} className="md-h">
          {inline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push(
        <blockquote key={k()}>
          <Markdown text={body.join("\n")} />
        </blockquote>,
      );
      continue;
    }

    // --- table: a header row followed by a |---|---| separator ---
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i++]));
      }
      out.push(
        <div key={k()} className="md-table-wrap">
          <table>
            <thead>
              <tr>{header.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => <td key={ci}>{inline(r[ci] ?? "")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // --- lists ---
    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const startIndent = (ordered ? OL.exec(line)![1] : UL.exec(line)![1]).length;
      const items: string[][] = [];

      while (i < lines.length) {
        const l = lines[i];
        const um = UL.exec(l);
        const om = OL.exec(l);
        const m = ordered ? om : um;

        if (m && m[1].length <= startIndent + 1) {
          items.push([ordered ? om![3] : um![2]]);
          i++;
        } else if (
          items.length > 0 &&
          (l.trim() === "" ? lines[i + 1]?.startsWith(" ") : l.startsWith(" "))
        ) {
          // Continuation or nested content: strip one indent level and let the
          // recursive render handle nesting.
          items[items.length - 1].push(l.replace(/^ {1,4}/, ""));
          i++;
        } else break;
      }

      const rendered = items.map((body, idx) => (
        <li key={idx}>
          <Markdown text={body.join("\n")} />
        </li>
      ));
      out.push(
        ordered ? <ol key={k()}>{rendered}</ol> : <ul key={k()}>{rendered}</ul>,
      );
      continue;
    }

    // --- paragraph ---
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(<p key={k()}>{inline(para.join("\n"))}</p>);
  }

  // A list item's body is rendered recursively; when it's a single paragraph,
  // unwrap it so items don't gain vertical padding.
  if (out.length === 1) return <>{out}</>;
  return <>{out}</>;
}
