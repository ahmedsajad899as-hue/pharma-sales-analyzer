import { readFileSync, writeFileSync } from 'fs';

const file = 'src/pages/DoctorsPage.tsx';
let src = readFileSync(file, 'utf8');

// Helper: replace once (throws if not found or multiple)
function rep(from, to) {
  const idx = src.indexOf(from);
  if (idx === -1) { console.error('NOT FOUND:', from.slice(0,60)); process.exit(1); }
  const second = src.indexOf(from, idx + 1);
  if (second !== -1) { console.error('MULTIPLE MATCHES:', from.slice(0,60)); process.exit(1); }
  src = src.slice(0, idx) + to + src.slice(idx + from.length);
  console.log('✅ replaced:', from.slice(0,50));
}

// ─── 1. add state + ref ───────────────────────────────────
rep(
  `  const [showOnlyVisited, setShowOnlyVisited] = useState(false);  const [showCoveragePopup, setShowCoveragePopup] = useState(false);
  const coverageCardRef = useRef<HTMLDivElement>(null);`,
  `  const [showOnlyVisited, setShowOnlyVisited] = useState(false);  const [showCoveragePopup, setShowCoveragePopup] = useState(false);
  const coverageCardRef = useRef<HTMLDivElement>(null);
  const [showTotalPopup, setShowTotalPopup] = useState(false);
  const totalCardRef = useRef<HTMLDivElement>(null);`
);

// ─── 2. add useEffect for totalPopup ─────────────────────
rep(
  `  useEffect(() => {
    if (!showCoveragePopup) return;
    const handler = (e: MouseEvent) => {
      if (coverageCardRef.current && !coverageCardRef.current.contains(e.target as Node))
        setShowCoveragePopup(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCoveragePopup]);
  useEffect(() => {
    if (!showWritingPopup) return;`,
  `  useEffect(() => {
    if (!showCoveragePopup) return;
    const handler = (e: MouseEvent) => {
      if (coverageCardRef.current && !coverageCardRef.current.contains(e.target as Node))
        setShowCoveragePopup(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCoveragePopup]);
  useEffect(() => {
    if (!showTotalPopup) return;
    const handler = (e: MouseEvent) => {
      if (totalCardRef.current && !totalCardRef.current.contains(e.target as Node))
        setShowTotalPopup(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTotalPopup]);
  useEffect(() => {
    if (!showWritingPopup) return;`
);

// ─── 3. make "إجمالي الأطباء" clickable ──────────────────
rep(
  `{ label: 'إجمالي الأطباء', value: total,   icon: '👥', accent: '#6366f1', clickable: false },`,
  `{ label: 'إجمالي الأطباء', value: total,   icon: '👥', accent: '#6366f1', clickable: 'total' },`
);

// ─── 4. update isActiveCard and handleClick ───────────────
rep(
  `const isActiveCard = s.clickable === 'coverage' ? showCoveragePopup : s.clickable === 'writing' ? showWritingPopup : s.clickable === 'visited' ? showVisitedPopup : false;
                  const borderColor  = isActiveCard ? s.accent : '#e2e8f0';
                  const handleClick  = s.clickable === 'coverage' ? () => setShowCoveragePopup(v => !v)
                                     : s.clickable === 'writing'  ? () => setShowWritingPopup(v => !v)
                                     : s.clickable === 'visited'  ? () => setShowVisitedPopup(v => !v)
                                     : undefined;`,
  `const isActiveCard = s.clickable === 'coverage' ? showCoveragePopup : s.clickable === 'writing' ? showWritingPopup : s.clickable === 'visited' ? showVisitedPopup : s.clickable === 'total' ? showTotalPopup : false;
                  const borderColor  = isActiveCard ? s.accent : '#e2e8f0';
                  const handleClick  = s.clickable === 'coverage' ? () => setShowCoveragePopup(v => !v)
                                     : s.clickable === 'writing'  ? () => setShowWritingPopup(v => !v)
                                     : s.clickable === 'visited'  ? () => setShowVisitedPopup(v => !v)
                                     : s.clickable === 'total'    ? () => setShowTotalPopup(v => !v)
                                     : undefined;`
);

// ─── 5. add totalCardRef to card ref assignment ───────────
rep(
  `ref={s.clickable === 'coverage' ? coverageCardRef : s.clickable === 'writing' ? writingCardRef : s.clickable === 'visited' ? visitedCardRef : undefined}`,
  `ref={s.clickable === 'coverage' ? coverageCardRef : s.clickable === 'writing' ? writingCardRef : s.clickable === 'visited' ? visitedCardRef : s.clickable === 'total' ? totalCardRef : undefined}`
);

// ─── 6. Replace all 4 popups with fixed-position versions ─
// Find the start and end of popup block
const popupStart = `                    {/* Visited doctors popup */}
                    {s.clickable === 'visited' && showVisitedPopup && (() => {`;

// Find coverage popup end
const coverageEnd = `                      </div>
                      </div>
                    )}

                    {/* Writing doctors popup */}`;

const startIdx = src.indexOf(popupStart);
const endIdx   = src.indexOf(coverageEnd);
if (startIdx === -1) { console.error('POPUP START NOT FOUND'); process.exit(1); }
if (endIdx   === -1) { console.error('COVERAGE END NOT FOUND'); process.exit(1); }
const endFull  = endIdx + coverageEnd.length;

// Also need to find writing popup end
const writingEnd = `                    })()}
                  </div>
                  );
                })}
              </div>
            );
          })()}`;

const writingEndIdx = src.indexOf(writingEnd, endFull);
if (writingEndIdx === -1) { console.error('WRITING END NOT FOUND'); process.exit(1); }
const writingEndFull = writingEndIdx + writingEnd.length;

console.log('Popup block:', startIdx, '→', writingEndFull);

// Read writing popup content (keep it, just fix the container)
// Let's read the current writing popup
const writingStart = src.indexOf(`{s.clickable === 'writing' && showWritingPopup`, endFull);
console.log('Writing popup at:', writingStart);

const newPopups = `                    {/* Total doctors popup - fixed modal */}
                    {s.clickable === 'total' && showTotalPopup && (() => {
                      const sorted = [...visitAreas].sort((a, b) => b.totalDoctors - a.totalDoctors);
                      return (
                        <>
                          <div onClick={() => setShowTotalPopup(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div onClick={e => e.stopPropagation()} style={{
                            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                            background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                            boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                            width: 'min(92vw,380px)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', direction: 'rtl',
                          }}>
                            <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: '#4338ca' }}>👥 توزيع الأطباء بالمناطق</span>
                              <button onClick={() => setShowTotalPopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
                            </div>
                            <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
                              {sorted.map((area, idx) => {
                                const pctArea = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
                                const barColor = pctArea >= 80 ? '#10b981' : pctArea >= 50 ? '#6366f1' : pctArea > 0 ? '#f59e0b' : '#d1d5db';
                                return (
                                  <div key={String(area.id)} style={{ padding: '8px 16px', borderBottom: idx < sorted.length - 1 ? '1px solid #f8fafc' : 'none' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ fontSize: 12, color: '#94a3b8' }}>📍</span>
                                        <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{area.name}</span>
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1', background: '#eef2ff', padding: '1px 9px', borderRadius: 10 }}>{area.totalDoctors}</span>
                                        <span style={{ fontSize: 11, color: barColor, fontWeight: 600, minWidth: 32, textAlign: 'right' }}>{pctArea}%</span>
                                      </div>
                                    </div>
                                    <div style={{ height: 4, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                                      <div style={{ width: \`\${pctArea}%\`, height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.3s' }} />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div style={{ padding: '8px 16px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
                              <span style={{ fontSize: 11, color: '#94a3b8' }}>الإجمالي</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: '#4338ca' }}>{total} طبيب في {sorted.length} منطقة</span>
                            </div>
                          </div>
                        </>
                      );
                    })()}

                    {/* Visited doctors popup - fixed modal */}
                    {s.clickable === 'visited' && showVisitedPopup && (() => {
                      const visitedDocs = visitAreas.flatMap(a => a.doctors.filter(d => d.visited));
                      return (
                        <>
                          <div onClick={() => setShowVisitedPopup(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div onClick={e => e.stopPropagation()} style={{
                            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                            background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                            boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                            width: 'min(92vw,420px)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', direction: 'rtl',
                          }}>
                            <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: '#065f46' }}>✅ الأطباء المُزارون ({visitedDocs.length})</span>
                              <button onClick={() => setShowVisitedPopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
                            </div>
                            {visitedDocs.length === 0 ? (
                              <div style={{ padding: '14px 16px', color: '#94a3b8', fontSize: 13 }}>لا توجد زيارات</div>
                            ) : (
                              <div style={{ overflowY: 'auto', flex: 1 }}>
                                {visitedDocs.map((doc, idx) => {
                                  const lastVisit = doc.visits[0];
                                  const item = lastVisit?.item ?? doc.targetItem;
                                  return (
                                    <div key={doc.id} style={{
                                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                                      gap: 10, padding: '9px 16px',
                                      borderBottom: idx < visitedDocs.length - 1 ? '1px solid #f1f5f9' : 'none',
                                      background: idx % 2 === 0 ? '#fff' : '#f0fdf4', direction: 'rtl',
                                    }}>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                          <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#d1fae5', color: '#065f46', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                                          <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{doc.name}</span>
                                        </div>
                                        <div style={{ paddingRight: 26, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                          {doc.specialty && <span style={{ fontSize: 11, color: '#64748b' }}>{doc.specialty}</span>}
                                          {doc.area && <span style={{ fontSize: 11, color: '#6366f1' }}>📍 {doc.area.name}</span>}
                                          {(doc as any).pharmacyName && <span style={{ fontSize: 11, color: '#0891b2' }}>🏪 {(doc as any).pharmacyName}</span>}
                                          {!doc.specialty && !doc.area && !(doc as any).pharmacyName && <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>}
                                        </div>
                                      </div>
                                      <div style={{ flexShrink: 0, paddingTop: 2 }}>
                                        {item && <span style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 8, padding: '2px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>💊 {item.name}</span>}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}

                    {/* Coverage popup - fixed modal */}
                    {s.clickable === 'coverage' && showCoveragePopup && (
                      <>
                        <div onClick={() => setShowCoveragePopup(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                        <div onClick={e => e.stopPropagation()} style={{
                          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                          background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                          boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                          width: 'min(92vw,360px)', maxHeight: '80vh',
                          display: 'flex', flexDirection: 'column', direction: 'rtl',
                        }}>
                          <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>📊 التغطية بالمناطق</span>
                            <button onClick={() => setShowCoveragePopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
                          </div>
                          <div style={{ overflowY: 'auto', flex: 1, padding: '8px 16px' }}>
                            {sortedAreas.map(area => {
                              const ap = area.totalDoctors > 0 ? Math.round(area.visitedCount / area.totalDoctors * 100) : 0;
                              const barColor = ap >= 80 ? '#10b981' : ap >= 50 ? '#6366f1' : ap > 0 ? '#f59e0b' : '#e2e8f0';
                              return (
                                <div key={String(area.id)} style={{ marginBottom: 11 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{area.name}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span style={{ fontSize: 11, color: '#94a3b8' }}>{area.visitedCount}/{area.totalDoctors}</span>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: barColor, minWidth: 34, textAlign: 'left' }}>{ap}%</span>
                                    </div>
                                  </div>
                                  <div style={{ height: 6, borderRadius: 99, background: '#f1f5f9', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', borderRadius: 99, width: \`\${ap}%\`, background: barColor, transition: 'width 0.4s ease' }} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}

                    {/* Writing doctors popup - fixed modal */}`;

// Find old writing popup block to replace
const writingOldStart = src.indexOf(`                    {s.clickable === 'writing' && showWritingPopup && (() => {`);
if (writingOldStart === -1) { console.error('WRITING OLD START NOT FOUND'); process.exit(1); }

// Find end of writing popup
const writingOldEnd = src.indexOf(`                    })()}
                  </div>
                  );
                })}`, writingOldStart);
if (writingOldEnd === -1) { console.error('WRITING OLD END NOT FOUND'); process.exit(1); }
const writingOldEndFull = writingOldEnd + `                    })()}
                  </div>
                  );
                })}`.length;

// Get old writing popup content (between start and end)
const oldWritingContent = src.slice(writingOldStart, writingOldEndFull);

// Build new writing popup
const allWritingDocsCode = oldWritingContent
  .replace(
    /return \(\s*<div\s+onClick={e => e\.stopPropagation\(\)}\s+style=\{\{[\s\S]*?\}\}>\s*<div style=\{\{[\s\S]*?rotate: '45deg',[\s\S]*?\}\} \/>/,
    `return (
                        <>
                          <div onClick={() => { setShowWritingPopup(false); setWritingItemFilter(null); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div onClick={e => e.stopPropagation()} style={{
                            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                            background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                            boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                            width: 'min(92vw,440px)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', direction: 'rtl',
                          }}>`
  )
  .replace(
    /maxHeight: 300, overflowY: 'auto'/,
    `overflowY: 'auto', flex: 1`
  )
  .replace(
    /\s*<\/div>\s*\);\s*\}\)\(\)\}/,
    `\n                          </div>\n                        </>\n                      );\n                    })()}`
  );

// Check if the regex replace worked by looking at the result
if (allWritingDocsCode === oldWritingContent) {
  console.log('WARNING: writing popup regex did not match, doing string replacement instead');
}

// Replace the whole old block (visited + coverage + writing) with new
const oldBlock = src.slice(startIdx, writingOldEndFull);
const visCodeStart = src.indexOf(`                    {s.clickable === 'visited' && showVisitedPopup`, startIdx);
const beforeVisited = src.slice(startIdx, visCodeStart);

// Replace from "Visited popup" comment to end of writing popup
src = src.slice(0, startIdx) + newPopups;

// Now add back the writing popup with fixed version
const writingPopupFixed = `
                    {s.clickable === 'writing' && showWritingPopup && (() => {
                      const allWritingDocs = visitAreas.flatMap(a => a.doctors.filter(d => d.isWriting))
                        .map(doc => ({ ...doc, _item: doc.visits.find(v => v.feedback === 'writing')?.item ?? doc.targetItem }));
                      const itemNames = [...new Set(
                        allWritingDocs.map(d => d._item?.name).filter(Boolean) as string[]
                      )].sort((a, b) => a.localeCompare(b));
                      const filtered = writingItemFilter
                        ? allWritingDocs.filter(d => d._item?.name === writingItemFilter)
                        : allWritingDocs;
                      return (
                        <>
                          <div onClick={() => { setShowWritingPopup(false); setWritingItemFilter(null); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
                          <div onClick={e => e.stopPropagation()} style={{
                            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                            background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0',
                            boxShadow: '0 12px 48px rgba(0,0,0,0.22)', zIndex: 999,
                            width: 'min(92vw,440px)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', direction: 'rtl',
                          }}>
                            <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: '#065f46' }}>
                                ✏️ الأطباء الكاتبون ({filtered.length}{writingItemFilter ? \`/\${allWritingDocs.length}\` : ''})
                              </span>
                              <button onClick={() => { setShowWritingPopup(false); setWritingItemFilter(null); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1 }}>×</button>
                            </div>
                            {itemNames.length > 0 && (
                              <div style={{ padding: '8px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0 }}>
                                <button onClick={() => setWritingItemFilter(null)} style={{
                                  fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                                  border: \`1.5px solid \${writingItemFilter === null ? '#10b981' : '#e2e8f0'}\`,
                                  background: writingItemFilter === null ? '#d1fae5' : '#f8fafc',
                                  color: writingItemFilter === null ? '#065f46' : '#64748b', cursor: 'pointer',
                                }}>الكل</button>
                                {itemNames.map(name => (
                                  <button key={name} onClick={() => setWritingItemFilter(prev => prev === name ? null : name)} style={{
                                    fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                                    border: \`1.5px solid \${writingItemFilter === name ? '#6d28d9' : '#e2e8f0'}\`,
                                    background: writingItemFilter === name ? '#ede9fe' : '#f8fafc',
                                    color: writingItemFilter === name ? '#6d28d9' : '#64748b', cursor: 'pointer',
                                  }}>💊 {name}</button>
                                ))}
                              </div>
                            )}
                            {filtered.length === 0 ? (
                              <div style={{ padding: '14px 16px', color: '#94a3b8', fontSize: 13 }}>لا يوجد أطباء لهذا الايتم</div>
                            ) : (
                              <div style={{ overflowY: 'auto', flex: 1 }}>
                                {filtered.map((doc, idx) => (
                                  <div key={doc.id} style={{
                                    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                                    gap: 10, padding: '9px 16px',
                                    borderBottom: idx < filtered.length - 1 ? '1px solid #f1f5f9' : 'none',
                                    background: idx % 2 === 0 ? '#fff' : '#f8fffe', direction: 'rtl',
                                  }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                        <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#d1fae5', color: '#065f46', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                                        <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{doc.name}</span>
                                      </div>
                                      <div style={{ paddingRight: 26, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        {doc.specialty && <span style={{ fontSize: 11, color: '#64748b' }}>{doc.specialty}</span>}
                                        {doc.area && <span style={{ fontSize: 11, color: '#6366f1' }}>📍 {doc.area.name}</span>}
                                        {(doc as any).pharmacyName && <span style={{ fontSize: 11, color: '#0891b2' }}>🏪 {(doc as any).pharmacyName}</span>}
                                        {!doc.specialty && !doc.area && !(doc as any).pharmacyName && <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>}
                                      </div>
                                    </div>
                                    <div style={{ flexShrink: 0, paddingTop: 2 }}>
                                      {doc._item && !writingItemFilter && <span style={{ fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 8, padding: '2px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>💊 {doc._item.name}</span>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  );
                })}` + src.slice(writingOldEndFull);

src = src.slice(0, startIdx) + newPopups + writingPopupFixed;

writeFileSync(file, src, 'utf8');
console.log('✅ All done. File size:', src.length);
