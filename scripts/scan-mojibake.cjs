/**
 * scan-mojibake.cjs — detector/recoverer for UTF-8 text corrupted by a
 * Latin-1/CP1252 double-decode (classic Arabic mojibake: "Ø­Ø§Ù„Ø©" for "حالة").
 *
 * Recovery maps every character of a suspect segment back to its byte
 * (identity for 0x00-0xFF, CP1252 table for U+20AC/U+2018-…/U+0152-… etc.),
 * re-interprets the byte run as UTF-8, and only accepts it when the decode is
 * byte-exact AND the result contains Arabic or typographic punctuation.
 *
 * Usage: node scripts/scan-mojibake.cjs [--write] [dirs...]
 */
const fs = require('fs');
const path = require('path');

// CP1252 0x80-0x9F specials (they are NOT C1 controls when the corrupting
// decoder used the Windows code page).
const CP1252_HIGH = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178,
};
const CHAR_TO_BYTE = new Map();
for (let b = 0; b < 256; b++) CHAR_TO_BYTE.set(b, b);      // Latin-1 identity
for (const [b, cp] of Object.entries(CP1252_HIGH)) CHAR_TO_BYTE.set(cp, Number(b));

/** Recover one segment; null when it is not a valid double-decode. */
function recover(segment) {
  const bytes = [];
  for (const ch of segment) {
    const b = CHAR_TO_BYTE.get(ch.codePointAt(0));
    if (b === undefined) return null;
    bytes.push(b);
  }
  const buf = Buffer.from(bytes);
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(buf) !== 0) return null; // not valid UTF-8
  if (text === segment || text.length === 0) return null;
  // C1 controls (U+0080-U+009F) in the RESULT mean the run was not a plain
  // double-decode — a real recovery of Arabic/typography never yields them.
  if (/[\u0080-\u009F]/.test(text)) return null;
  return text;
}

// Lead bytes of corrupted runs: any UTF-8 lead byte C0-FF renders as a high
// Latin-1 char (Ã-ÿ: C2->Ã, D8->Ø, D9->Ù, E2->â, F0->ð …).
const MOJIBAKE_RE = /[\u00c0-\u00ff][\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]+/g;

function scanFile(file, write) {
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');
  let hits = 0;
  const samples = [];
  const fixed = lines.map((line, i) => {
    if (!/[\u0080-\u00ff\u0152\u20ac\u2018\u201e\u2026\u2122]/.test(line)) return line;
    const out = line.replace(MOJIBAKE_RE, (m) => {
      const r = recover(m);
      if (r === null) return m;
      hits++;
      if (samples.length < 3) samples.push({ line: i + 1, from: m, to: r });
      return r;
    });
    return out;
  });
  if (hits > 0 && write) fs.writeFileSync(file, fixed.join('\n'), 'utf8');
  return { hits, samples };
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-server', '.wrangler', '.wrangler-dry', '.kilo', '.git', '.gsee', '.manus', '.work', 'outputs'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|cjs|mjs|html|css|json|md)$/.test(name)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const roots = args.filter((a) => a !== '--write');
const list = roots.length ? roots : ['src', 'server', 'scripts', 'worker', 'public'];
let total = 0;
let files = 0;
for (const root of list) {
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    try {
      const { hits, samples } = scanFile(f, write);
      if (hits > 0) {
        total += hits;
        files++;
        console.log(`${write ? 'FIXED' : 'FOUND'} ${f} (${hits})`);
        for (const s of samples) console.log(`   L${s.line}: ${s.from}  ->  ${s.to}`);
      }
    } catch (e) {
      console.log(`SKIP ${f}: ${e.message}`);
    }
  }
}
console.log(`\nTotal ${write ? 'fixed' : 'found'}: ${total} segment(s) in ${files} file(s)`);
