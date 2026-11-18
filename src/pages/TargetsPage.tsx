import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import TargetsImportModal from '../components/TargetsImportModal';
import TargetsMatrix from '../components/TargetsMatrix';
import type { MatrixRep } from '../components/targetGroups';
import { fetchActuals, fmtQty, pctClass, pctText, type ActualRow, type RepActuals } from '../components/TargetCompare';

const API = import.meta.env.VITE_API_URL || '';

interface NamedItem { id: number; name: string; }
interface SavedTarget { id: number; itemId: number; item: NamedItem; target: number; month: number; year: number; }

const NOW = new Date();

// Roles allowed to create/sync targets for reps — office_hr كان ناقصاً هنا رغم
// أنه دور مكتبي بنفس صلاحيات office_manager/office_employee في كل مكان آخر
// (officeScope.js)، فكان يقع في فرع "عرض تارگتاتي الشخصية" بدل عرض تارگتات
// فريق المكتب، ويظهر له دوماً "لم يُعيَّن أي تارگت لك" لأنه لا يملك تارگتاً
// شخصياً أصلاً.
const MANAGER_ROLES = new Set(['admin', 'manager', 'company_manager', 'team_leader', 'supervisor', 'office_manager', 'product_manager', 'commercial_supervisor', 'commercial_team_leader', 'office_employee', 'office_hr']);

// أُزيل خيار «علمي/تجاري» من الشاشة: نوع المندوبين يتحدد من دور المستخدم، فالإدارة
// التجارية تبقى تعمل على مندوبيها والبقية على العلميين
const COMMERCIAL_ROLES = new Set(['commercial_supervisor', 'commercial_team_leader']);

const MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const YEARS = Array.from({ length: 5 }, (_, i) => NOW.getFullYear() - 2 + i);

export default function TargetsPage({ activeFileIds = [] }: { activeFileIds?: number[] }) {
  const { token, user } = useAuth();
  const H = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const isManager = MANAGER_ROLES.has(user?.role ?? '');
  const repType: 'scientific' | 'commercial' = COMMERCIAL_ROLES.has(user?.role ?? '') ? 'commercial' : 'scientific';

  const [sciReps, setSciReps] = useState<MatrixRep[]>([]);
  const [commReps, setCommReps] = useState<MatrixRep[]>([]);
  const [month, setMonth] = useState(NOW.getMonth() + 1);
  const [year, setYear] = useState(NOW.getFullYear());
  const [myTargets, setMyTargets] = useState<SavedTarget[]>([]);
  const [myActuals, setMyActuals] = useState<RepActuals | null>(null);
  const [loading, setLoading] = useState(false);
  const [allItems, setAllItems] = useState<NamedItem[]>([]);
  // الاستيراد يعمل على مندوبي التبويب المعروض (شركة / مسوقين)
  const [importFor, setImportFor] = useState<{ reps: MatrixRep[]; groupName: string } | null>(null);
  const [importKey, setImportKey] = useState(0);

  // تارگتات المندوب نفسه — للاطلاع فقط
  useEffect(() => {
    if (isManager) return;
    setLoading(true);
    const qs = new URLSearchParams({ month: String(month), year: String(year) });
    fetch(`${API}/api/targets/mine?${qs}`, { headers: H() })
      .then(r => r.json())
      .then(j => setMyTargets(j.data ?? []))
      .catch(() => setMyTargets([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager, month, year, token]);

  // مبيعه النت مقابل تارگته — الخادم يقيّد غير الإدارة بسجله هو
  const fileKey = activeFileIds.join(',');
  useEffect(() => {
    setMyActuals(null);
    if (isManager || !fileKey) return;
    let cancelled = false;
    fetchActuals(null, { month, year, fileIds: fileKey.split(',').map(Number) }, token)
      .then(d => { if (!cancelled) setMyActuals(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isManager, month, year, fileKey, token]);

  // كل من يُعيَّن له تارگت: المندوبون (علمي ومسوق، بغداد ومحافظات) وقادة الفرق والمدراء
  useEffect(() => {
    if (!isManager || repType !== 'scientific') return;
    fetch(`${API}/api/targets/people`, { headers: H() })
      .then(r => r.json())
      .then(j => setSciReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isManager, repType]);

  useEffect(() => {
    if (!isManager || repType !== 'commercial') return;
    if (activeFileIds.length === 0) { setCommReps([]); return; }
    fetch(`${API}/api/representatives?fileIds=${activeFileIds.join(',')}`, { headers: H() })
      .then(r => r.json())
      .then(j => setCommReps(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isManager, repType, activeFileIds.join(',')]);

  // كل الايتمات — صفوف الجدول للمندوبين بلا نطاق ايتمات محدد
  useEffect(() => {
    if (!isManager) return;
    fetch(`${API}/api/items`, { headers: H() })
      .then(r => r.json())
      .then(j => setAllItems(Array.isArray(j) ? j : (j.data ?? [])))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isManager]);

  // كل الأشخاص: الجدول يقسمهم تبويبات (شركة لكل مدير + مسوقين بغداد/المحافظات)،
  // وبغداد/المحافظات صار فلتراً داخل الشركة نفسها
  const reps: MatrixRep[] = repType === 'scientific' ? sciReps : commReps;

  const periodControls = (
    <>
      <div className="tg-title">التارگت الشهري</div>
      <select className="tg-sel" value={month} onChange={e => setMonth(parseInt(e.target.value))} title="الشهر">
        {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
      </select>
      <select className="tg-sel" value={year} onChange={e => setYear(parseInt(e.target.value))} title="السنة">
        {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </>
  );

  if (isManager) {
    return (
      <div className="page tg-page" dir="rtl">
        <TargetsMatrix
          repType={repType}
          reps={reps}
          allItems={allItems}
          month={month}
          year={year}
          monthLabel={MONTHS[month - 1]}
          activeFileIds={activeFileIds}
          token={token}
          reloadKey={importKey}
          controls={periodControls}
          actions={ctx => (
            <button className="tg-btn" onClick={() => setImportFor(ctx)}
              title={`استيراد التارگت من ملف إكسل وتعميمه على مندوبي ${ctx.groupName || 'المجموعة'} أو قسم منهم`}>
              استيراد إكسل
            </button>
          )}
        />
        {importFor && (
          <TargetsImportModal
            repType={repType}
            reps={importFor.reps.filter(r => r.id > 0)}
            allItems={allItems}
            month={month}
            year={year}
            monthLabel={MONTHS[month - 1]}
            token={token}
            onClose={() => setImportFor(null)}
            onDone={() => setImportKey(k => k + 1)}
          />
        )}
      </div>
    );
  }

  const total = myTargets.reduce((s, t) => s + t.target, 0);
  const actualOf = new Map<number, ActualRow>();
  myActuals?.rows.forEach(r => r.itemIds.forEach(id => actualOf.set(id, r)));
  // صفّان بنفس الاسم يشتركان في مبيع واحد: يُعرض على الأول فقط حتى لا يبدو مكرراً
  const shownOnce = new Set<ActualRow>();
  const showCompare = !!myActuals;

  return (
    <div className="page" dir="rtl" style={{ maxWidth: 1000 }}>
      <div className="tg-bar">{periodControls}</div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--c-text-secondary)' }}>جاري التحميل...</div>
      ) : myTargets.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--c-text-secondary)' }}>
          لم يتم تعيين أي تارگت لك هذا الشهر
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>اسم الايتم</th>
                <th style={{ textAlign: 'center', width: 140 }}>التارگت (عدد)</th>
                {showCompare && <>
                  <th style={{ textAlign: 'center', width: 120 }}>المبيع النت</th>
                  <th style={{ textAlign: 'center', width: 90 }}>الإنجاز</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {myTargets.map((t, i) => {
                const row = actualOf.get(t.itemId);
                const first = !!row && !shownOnce.has(row);
                if (row) shownOnce.add(row);
                return (
                  <tr key={t.id}>
                    <td style={{ color: 'var(--c-text-muted)' }}>{i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{t.item.name}</td>
                    <td style={{ textAlign: 'center', fontWeight: 800 }}>
                      {t.target.toLocaleString('en-US')}
                    </td>
                    {showCompare && <>
                      <td style={{ textAlign: 'center', fontWeight: 700 }}>{first ? fmtQty(row!.net) : ''}</td>
                      <td style={{ textAlign: 'center', fontWeight: 700 }} className={first ? pctClass(row!.pct) : ''}>{first ? pctText(row!.pct) : ''}</td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} style={{ fontWeight: 700 }}>الإجمالي</td>
                <td style={{ textAlign: 'center', fontWeight: 800 }}>{total.toLocaleString('en-US')}</td>
                {showCompare && <>
                  <td style={{ textAlign: 'center', fontWeight: 800 }}>{fmtQty(myActuals!.totalNet)}</td>
                  <td style={{ textAlign: 'center', fontWeight: 800 }} className={pctClass(myActuals!.pct)}>{pctText(myActuals!.pct)}</td>
                </>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
