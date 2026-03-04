import { useState, useMemo } from 'react';

interface FilterPanelProps {
  columns: string[];
  data: any[];
  onFilter: (filters: Record<string, any>) => void;
}

export function FilterPanel({ columns, data, onFilter }: FilterPanelProps) {
  const [filters, setFilters] = useState({
    drugName: '',
    dateFrom: '',
    dateTo: '',
    minSales: 0,
    selectedColumn: columns[0] || '',
    salesRep: '',
    region: ''
  });

  // استخراج المندوبين من البيانات
  const salesReps = useMemo(() => {
    const reps = new Set<string>();
    
    data.forEach(row => {
      Object.entries(row).forEach(([key, value]) => {
        if (key.toLowerCase().includes('rep') || key.toLowerCase().includes('مندوب')) {
          if (value) reps.add(String(value));
        }
      });
    });
    
    return Array.from(reps).sort();
  }, [data]);

  // استخراج المناطق الخاصة بالمندوب المختار
  const regions = useMemo(() => {
    if (!filters.salesRep) return [];
    
    const regs = new Set<string>();
    const repColumn = Object.keys(data[0] || {}).find(k =>
      k.toLowerCase().includes('rep') || k.toLowerCase().includes('مندوب')
    );
    const regionColumn = Object.keys(data[0] || {}).find(k =>
      k.toLowerCase().includes('region') || k.toLowerCase().includes('منطقة')
    );
    
    data.forEach(row => {
      if (repColumn && regionColumn) {
        if (String(row[repColumn]) === filters.salesRep) {
          if (row[regionColumn]) {
            regs.add(String(row[regionColumn]));
          }
        }
      }
    });
    
    return Array.from(regs).sort();
  }, [data, filters.salesRep]);

  const handleChange = (field: string, value: any) => {
    let updated = { ...filters, [field]: value };
    // إذا تم تغيير المندوب، أعد تعيين المنطقة
    if (field === 'salesRep') {
      updated.region = '';
    }
    setFilters(updated);
    onFilter(updated);
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <h3 className="text-lg font-bold mb-4">الفلاتر</h3>
      
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-semibold mb-2">المندوب</label>
          <select
            value={filters.salesRep}
            onChange={(e) => handleChange('salesRep', e.target.value)}
            className="w-full p-2 border rounded"
          >
            <option value="">- جميع المندوبين -</option>
            {salesReps.map(rep => (
              <option key={rep} value={rep}>{rep}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-2">المنطقة</label>
          <select
            value={filters.region}
            onChange={(e) => handleChange('region', e.target.value)}
            disabled={!filters.salesRep}
            className="w-full p-2 border rounded disabled:bg-gray-100 disabled:cursor-not-allowed"
          >
            <option value="">- اختر مندوب أولاً -</option>
            {regions.map(reg => (
              <option key={reg} value={reg}>{reg}</option>
            ))}
          </select>
          {!filters.salesRep && <p className="text-xs text-gray-500 mt-1">اختر مندوب لتحديد المناطق</p>}
        </div>

        <div>
          <label className="block text-sm font-semibold mb-2">اسم الدواء</label>
          <input
            type="text"
            placeholder="ابحث عن دواء..."
            value={filters.drugName}
            onChange={(e) => handleChange('drugName', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold mb-2">من التاريخ</label>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => handleChange('dateFrom', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold mb-2">إلى التاريخ</label>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => handleChange('dateTo', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold mb-2">الحد الأدنى للمبيعات</label>
          <input
            type="number"
            placeholder="0"
            value={filters.minSales}
            onChange={(e) => handleChange('minSales', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>
      </div>
    </div>
  );
}