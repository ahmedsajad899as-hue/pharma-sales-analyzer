/**
 * AnalysisRenderer
 * Converts AI-generated markdown text into styled, structured HTML cards.
 * Handles: headers, | pipe tables |, bullet lists, bold, numbered lists.
 */

interface Props { text: string; }

export default function AnalysisRenderer({ text }: Props) {
  const sections = parseIntoSections(text);
  return (
    <div className="ar-root">
      {sections.map((sec, i) => (
        <div key={i} className="ar-section" data-sec={sec.secNum || undefined}>
          {sec.title && (
            <div className="ar-section-header">
              <span className="ar-section-icon">{sec.icon}</span>
              <h3 className="ar-section-title">{sec.title}</h3>
              {sec.secNum && (
                <span style={{
                  fontSize: 11, fontWeight: 700, opacity: 0.5,
                  background: 'rgba(0,0,0,.07)', padding: '2px 6px', borderRadius: 10,
                }}>#{sec.secNum}</span>
              )}
            </div>
          )}
          {sec.blocks.map((block, j) =>
            block.type === 'subsection'
              ? <div key={j} className="ar-subsection" dangerouslySetInnerHTML={{ __html: inlineFormat(block.lines[0] || '') }} />
              : renderBlock(block, j)
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────── Types ────────────────────────────
type BlockType = 'table' | 'bullets' | 'kv' | 'text' | 'subsection';
interface Block { type: BlockType; lines: string[]; }
interface Section { title: string; icon: string; secNum: number | null; blocks: Block[]; }

// ─────────────────────────── Render ───────────────────────────
function renderBlock(block: Block, key: number) {
  switch (block.type) {
    case 'table':   return <TableBlock key={key} lines={block.lines} />;
    case 'bullets': return <BulletsBlock key={key} lines={block.lines} />;
    case 'kv':      return <KVBlock key={key} lines={block.lines} />;
    default:        return block.lines.some(l => l.trim()) ? (
      <p key={key} className="ar-text"
         dangerouslySetInnerHTML={{ __html: inlineFormat(block.lines.join(' ')) }} />
    ) : null;
  }
}

function TableBlock({ lines }: { lines: string[] }) {
  // Find header row (first non-separator row)
  const rows = lines.map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  const headerIdx = rows.findIndex(r => r.some(c => c.length > 0));
  if (headerIdx === -1) return null;
  const header = rows[headerIdx];
  const body   = rows.slice(headerIdx + 1).filter(r => !r.every(c => /^[-: ]+$/.test(c)));
  return (
    <div className="ar-table-wrap">
      <table className="ar-table">
        <thead>
          <tr>{header.map((h, i) => <th key={i}>{inlineFormat(h)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(cell) }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BulletsBlock({ lines }: { lines: string[] }) {
  return (
    <ul className="ar-list">
      {lines.map((l, i) => {
        const text = l.replace(/^[-•*]\s*/, '');
        return (
          <li key={i} className="ar-list-item"
              dangerouslySetInnerHTML={{ __html: inlineFormat(text) }} />
        );
      })}
    </ul>
  );
}

function KVBlock({ lines }: { lines: string[] }) {
  return (
    <div className="ar-kv-grid">
      {lines.map((l, i) => {
        const colonIdx = l.indexOf(':');
        if (colonIdx === -1) return (
          <div key={i} className="ar-kv-item ar-kv-item--full"
               dangerouslySetInnerHTML={{ __html: inlineFormat(l) }} />
        );
        const k = l.slice(0, colonIdx).replace(/^[-•*]\s*/, '').trim();
        const v = l.slice(colonIdx + 1).trim();
        return (
          <div key={i} className="ar-kv-item">
            <span className="ar-kv-key">{inlineFormat(k)}</span>
            <span className="ar-kv-val" dangerouslySetInnerHTML={{ __html: inlineFormat(v) }} />
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────── Parser ───────────────────────────
const SECTION_ICONS: Record<string, string> = {
  'مبيعات حسب المندوب': '👤',
  'مبيعات حسب الصنف':   '💊',
  'مبيعات حسب المنطقة': '📍',
  'ملخص':               '📊',
  'summary':            '📊',
  'representative':     '👤',
  'item':               '💊',
  'region':             '📍',
  'area':               '📍',
};

function getSectionIcon(title: string): string {
  const t = title.toLowerCase();
  for (const [k, v] of Object.entries(SECTION_ICONS)) {
    if (t.includes(k.toLowerCase())) return v;
  }
  if (t.match(/[123]|أول|ثاني|ثالث/)) {
    const n = t.match(/1|أول/) ? '1️⃣' : t.match(/2|ثاني/) ? '2️⃣' : '3️⃣';
    return n;
  }
  return '📌';
}

function parseIntoSections(raw: string): Section[] {
  const lines = raw.split('\n');
  const sections: Section[] = [];
  let currentSection: Section = { title: '', icon: '📋', secNum: null, blocks: [] };
  let pendingLines: string[] = [];

  function flushPending() {
    if (!pendingLines.length) return;
    const block = classifyLines(pendingLines);
    if (block) currentSection.blocks.push(block);
    pendingLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Sub-section header: ### (inside a section)
    const isSubHeader = /^#{3,}\s/.test(line);
    // Main section header: ## or numbered
    const isH2 = /^#{1,2}\s/.test(line) ||
                 (/^[\*_]{0,2}\d+[.)]\s/.test(line) && line.length > 5 && !line.includes('|'));
    const isHeader = isH2;

    if (isSubHeader && !isH2) {
      flushPending();
      const subTitle = line.replace(/^#+\s*/, '').replace(/^[\*_]+|[\*_]+$/g, '').trim();
      currentSection.blocks.push({ type: 'subsection', lines: [subTitle] });
      continue;
    }

    if (isHeader) {
      flushPending();
      if (currentSection.title || currentSection.blocks.length) {
        sections.push(currentSection);
      }
      const titleClean = line
        .replace(/^#+\s*/, '')
        .replace(/^[\*_]+/, '')
        .replace(/[\*_]+$/, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim();
      // Extract section number from title (e.g. "1. Drug Profile" → 1)
      const numMatch = titleClean.match(/^(\d+)[.)]?\s/) || line.match(/^#{1,2}\s+[^\d]*(\d+)[.)]?/);
      const secNum = numMatch ? parseInt(numMatch[1]) : null;
      currentSection = { title: titleClean, icon: getSectionIcon(titleClean), secNum, blocks: [] };
      continue;
    }

    // Separator line (---) → flush + skip
    if (/^[-=─━]{3,}/.test(line)) {
      flushPending();
      continue;
    }

    // Table row
    if (line.includes('|') && line.trim().startsWith('|')) {
      // Flush any non-table pending
      const lastPending = pendingLines[pendingLines.length - 1];
      if (lastPending !== undefined && !lastPending.includes('|')) flushPending();
      pendingLines.push(line);
      continue;
    }

    // If we were accumulating table rows and now we're not...
    if (pendingLines.length > 0 && pendingLines[0].includes('|') && !line.includes('|')) {
      flushPending();
    }

    if (line.trim()) pendingLines.push(line);
    else {
      flushPending();
    }
  }

  flushPending();
  if (currentSection.title || currentSection.blocks.length) {
    sections.push(currentSection);
  }

  return sections.filter(s => s.blocks.length > 0 || s.title);
}

function classifyLines(lines: string[]): Block | null {
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return null;

  // Table
  if (nonEmpty.some(l => l.includes('|') && l.trim().startsWith('|'))) {
    return { type: 'table', lines: nonEmpty };
  }

  // Bullets
  if (nonEmpty.length > 0 && nonEmpty.every(l => /^[-•*]\s/.test(l.trim()))) {
    return { type: 'bullets', lines: nonEmpty.map(l => l.trim()) };
  }

  // KV pairs (multiple lines with colons)
  const kvCount = nonEmpty.filter(l => l.includes(':')).length;
  if (kvCount >= 2 && kvCount >= nonEmpty.length * 0.6) {
    return { type: 'kv', lines: nonEmpty.map(l => l.trim().replace(/^[-•*]\s*/, '')) };
  }

  return { type: 'text', lines: nonEmpty };
}

function inlineFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
}
