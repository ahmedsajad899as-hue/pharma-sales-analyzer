import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import type { GroupableRep } from '../components/RepSelectOptions';
import TargetsImportModal from '../components/TargetsImportModal';
import TargetsMatrix from '../components/TargetsMatrix';
import ProvinceRepsToggle, { useProvinceRepScope, filterByProvinceScope } from '../components/ProvinceRepsToggle';

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

  const [sciReps, setSciReps] = useState<GroupableRep[]>([]);
  // بغداد افتراضياً؛ زر «مندوبي المحافظات» يعرضهم وحدهم (راجع ProvinceRepsToggle)
  const [onlyProvince, setOnlyProvince] = useProvinceRepScope('targets');
  const [commReps, setCommReps] = useState<GroupableRep[]>([]);
  const [month, setMonth] = useState(NOW.getMonth() + 1);
  const [year, setYear] = useState(NOW.getFullYear());
  const [myTargets, setMyTargets] = useState<SavedTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [allItems, setAllItems] = useState<NamedItem[]>([]);
  const [showImport, setShowImport] = useState(false);
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

  // Load reps — unified list (system reps + standalone reps created by this manager)
  useEffect(() => {
    if (!isManager || repType !== 'scientific') return;
    fetch(`${API}/api/scientific-reps`, { headers: H() })
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

  const reps = repType === 'scientific' ? filterByProvinceScope(sciReps, onlyProvince) : commReps;

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
          token={token}
          reloadKey={importKey}
          controls={<>
            {periodControls}
            {repType === 'scientific' && (
              <ProvinceRepsToggle reps={sciReps} value={onlyProvince} onChange={setOnlyProvince} compact />
            )}
          </>}
          actions={
            <button className="tg-btn" onClick={() => setShowImport(true)}
              title="استيراد التارگت من ملف إكسل وتعميمه على كل المندوبين أو قسم منهم">
              استيراد إكسل
            </button>
          }
        />
        {showImport && (
          <TargetsImportModal
            repType={repType}
            reps={reps}
            allItems={allItems}
            month={month}
            year={year}
            monthLabel={MONTHS[month - 1]}
            token={token}
            onClose={() => setShowImport(false)}
            onDone={() => setImportKey(k => k + 1)}
          />
        )}
      </div>
    );
  }

  const total = myTargets.reduce((s, t) => s + t.target, 0);

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
              </tr>
            </thead>
            <tbody>
              {myTargets.map((t, i) => (
                <tr key={t.id}>
                  <td style={{ color: 'var(--c-text-muted)' }}>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{t.item.name}</td>
                  <td style={{ textAlign: 'center', fontWeight: 800 }}>
                    {t.target.toLocaleString('en-US')}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} style={{ fontWeight: 700 }}>الإجمالي</td>
                <td style={{ textAlign: 'center', fontWeight: 800 }}>{total.toLocaleString('en-US')}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
