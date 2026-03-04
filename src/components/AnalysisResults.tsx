import React, { useState, useMemo, useRef, useEffect } from 'react';
import axios from 'axios';

interface AnalysisResultsProps {
  data: any[];
  filters: Record<string, any>;
}

// تحويل النص إلى HTML مع تنسيق Markdown بسيط
function formatAnalysisText(text: string): string {
  let html = text
    // Headers
    .replace(/^### (.+)$/gm, '<h3 class="analysis-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="analysis-h2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="analysis-h1">$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic  
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Tables - detect markdown tables
    .replace(/\n?\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g, (_match, header, body) => {
      const headerCells = header.split('|').map((c: string) => c.trim()).filter(Boolean);
      const rows = body.trim().split('\n').map((row: string) => 
        row.split('|').map((c: string) => c.trim()).filter(Boolean)
      );
      let table = '<div class="analysis-table-wrap"><table class="analysis-table"><thead><tr>';
      headerCells.forEach((cell: string) => { table += `<th>${cell}</th>`; });
      table += '</tr></thead><tbody>';
      rows.forEach((row: string[]) => {
        table += '<tr>';
        row.forEach((cell: string) => { table += `<td>${cell}</td>`; });
        table += '</tr>';
      });
      table += '</tbody></table></div>';
      return table;
    })
    // Horizontal rules
    .replace(/^[━─═]{3,}$/gm, '<hr class="analysis-hr"/>')
    .replace(/^---+$/gm, '<hr class="analysis-hr"/>')
    // Bullet points
    .replace(/^[•●▪] (.+)$/gm, '<li class="analysis-li">$1</li>')
    .replace(/^- (.+)$/gm, '<li class="analysis-li">$1</li>')
    // Numbered lists
    .replace(/^(\d+)\. (.+)$/gm, '<div class="analysis-numbered"><span class="analysis-num">$1</span><span>$2</span></div>')
    // Line breaks
    .replace(/\n\n/g, '</p><p class="analysis-p">')
    .replace(/\n/g, '<br/>');

  return `<p class="analysis-p">${html}</p>`;
}

export function AnalysisResults({ data, filters }: AnalysisResultsProps) {
  const [analysis, setAnalysis] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiPowered, setAiPowered] = useState(false);
  const [viewMode, setViewMode] = useState<'analysis' | 'table'>('analysis');
  const [progress, setProgress] = useState(0);
  const analysisRef = useRef<HTMLDivElement>(null);

  // تأثير شريط التقدم أثناء التحميل
  useEffect(() => {
    let interval: any;
    if (loading) {
      setProgress(0);
      interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90) return prev;
          return prev + Math.random() * 15;
        });
      }, 500);
    } else {
      setProgress(100);
      setTimeout(() => setProgress(0), 500);
    }
    return () => clearInterval(interval);
  }, [loading]);

  // التمرير لنتائج التحليل بعد ظهورها
  useEffect(() => {
    if (analysis && analysisRef.current) {
      analysisRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [analysis]);

  // بناء جدول المندوبين والمبيعات
  const repSalesData = useMemo(() => {
    const salesByRep: Record<string, any> = {};
    
    let filteredData = data;
    
    if (filters.salesRep) {
      filteredData = filteredData.filter(row =>
        Object.values(row).some(val => String(val).includes(filters.salesRep))
      );
    }
    if (filters.region) {
      filteredData = filteredData.filter(row =>
        Object.values(row).some(val => String(val).includes(filters.region))
      );
    }
    if (filters.drugName) {
      filteredData = filteredData.filter(row =>
        Object.values(row).some(val => String(val).toLowerCase().includes(filters.drugName.toLowerCase()))
      );
    }
    
    const repColumn = Object.keys(data[0] || {}).find(k => 
      k.toLowerCase().includes('rep') || k.toLowerCase().includes('مندوب')
    );
    const regionColumn = Object.keys(data[0] || {}).find(k => 
      k.toLowerCase().includes('region') || k.toLowerCase().includes('منطقة')
    );
    const drugColumn = Object.keys(data[0] || {}).find(k => 
      k.toLowerCase().includes('drug') || k.toLowerCase().includes('دواء') || k.toLowerCase().includes('product')
    );
    const saleColumn = Object.keys(data[0] || {}).find(k => 
      k.toLowerCase().includes('sale') || k.toLowerCase().includes('مبيعات') || k.toLowerCase().includes('quantity')
    );
    
    filteredData.forEach(row => {
      const rep = repColumn ? row[repColumn] : 'غير محدد';
      const region = regionColumn ? row[regionColumn] : 'غير محدد';
      const drug = drugColumn ? row[drugColumn] : 'منتج';
      const sale = saleColumn ? parseFloat(row[saleColumn]) || 0 : 0;
      const key = `${rep}|${region}`;
      
      if (!salesByRep[key]) {
        salesByRep[key] = { rep, region, products: {}, total: 0 };
      }
      if (!salesByRep[key].products[drug]) {
        salesByRep[key].products[drug] = { count: 0, total: 0 };
      }
      salesByRep[key].products[drug].count += 1;
      salesByRep[key].products[drug].total += sale;
      salesByRep[key].total += sale;
    });
    
    return Object.values(salesByRep);
  }, [data, filters]);

  const handleAnalyze = async () => {
    setLoading(true);
    setAnalysis('');
    try {
      const response = await axios.post('/api/analyze', { data, filters });
      setAnalysis(response.data.analysis);
      setAiPowered(response.data.aiPowered || false);
      setViewMode('analysis');
    } catch (error: any) {
      setAnalysis('❌ خطأ في التحليل: ' + error.message);
      setViewMode('analysis');
    } finally {
      setLoading(false);
    }
  };

  const totalSales = repSalesData.reduce((sum, item) => sum + item.total, 0);

  return (
    <div ref={analysisRef}>
      {/* بطاقة الأزرار والتحكم */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center text-white text-lg">
              📊
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-800">نتائج التحليل</h3>
              <p className="text-xs text-gray-500">{data.length > 0 ? `${data.length} سجل جاهز للتحليل` : 'ارفع ملفاً للبدء'}</p>
            </div>
            {aiPowered && (
              <span className="bg-gradient-to-r from-purple-100 to-blue-100 text-purple-700 text-xs px-3 py-1.5 rounded-full font-semibold border border-purple-200">
                🤖 Gemini AI
              </span>
            )}
          </div>
          
          <div className="flex gap-2 w-full sm:w-auto">
            <button
              onClick={handleAnalyze}
              disabled={data.length === 0 || loading}
              className="flex-1 sm:flex-none bg-gradient-to-r from-blue-500 to-purple-600 text-white px-5 py-2.5 rounded-xl 
                         hover:from-blue-600 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-400 
                         disabled:cursor-not-allowed transition-all duration-300 font-medium text-sm
                         shadow-md hover:shadow-lg disabled:shadow-none"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  جاري التحليل...
                </span>
              ) : '🤖 تحليل بالذكاء الاصطناعي'}
            </button>
            {analysis && (
              <button
                onClick={() => setViewMode(viewMode === 'analysis' ? 'table' : 'analysis')}
                className="bg-gray-100 text-gray-700 px-4 py-2.5 rounded-xl hover:bg-gray-200 
                           transition-all duration-200 font-medium text-sm border border-gray-200"
              >
                {viewMode === 'analysis' ? '📋 الجدول' : '📊 التحليل'}
              </button>
            )}
          </div>
        </div>

        {/* شريط التقدم */}
        {loading && (
          <div className="mt-4">
            <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-blue-500 to-purple-600 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-2 text-center">يتم تحليل {data.length} سجل بالذكاء الاصطناعي...</p>
          </div>
        )}
      </div>

      {/* عرض التحليل */}
      {viewMode === 'analysis' && analysis && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {/* شريط علوي ملون */}
          <div className="h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />
          
          <div className="p-6 sm:p-8">
            <div 
              className="analysis-content prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: formatAnalysisText(analysis) }}
            />
          </div>
        </div>
      )}

      {/* رسالة فارغة */}
      {viewMode === 'analysis' && !analysis && !loading && data.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
          <div className="text-5xl mb-4">🤖</div>
          <h4 className="text-lg font-semibold text-gray-700 mb-2">جاهز للتحليل</h4>
          <p className="text-gray-400 text-sm">اضغط على زر "تحليل بالذكاء الاصطناعي" للحصول على تقرير مفصل</p>
        </div>
      )}

      {/* عرض الجدول */}
      {viewMode === 'table' && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-green-400 to-emerald-500" />
          {repSalesData.length > 0 ? (
            <div className="p-4 sm:p-6">
              <div className="overflow-x-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-gray-50 to-gray-100">
                      <th className="p-3 text-right font-semibold text-gray-600 border-b">المندوب</th>
                      <th className="p-3 text-right font-semibold text-gray-600 border-b">المنطقة</th>
                      <th className="p-3 text-right font-semibold text-gray-600 border-b">المنتج</th>
                      <th className="p-3 text-center font-semibold text-gray-600 border-b">الكمية</th>
                      <th className="p-3 text-center font-semibold text-gray-600 border-b">القيمة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repSalesData.map((rep, idx) => {
                      const products = Object.entries(rep.products);
                      return (
                        <React.Fragment key={idx}>
                          {products.map(([product, sales]: [string, any], pidx) => (
                            <tr key={`${idx}-${pidx}`} className="border-b border-gray-50 hover:bg-blue-50/30 transition-colors">
                              {pidx === 0 ? (
                                <>
                                  <td rowSpan={products.length} className="p-3 font-bold text-gray-800 bg-blue-50/50 border-b text-right align-top">
                                    <div className="flex items-center gap-2">
                                      <span className="w-7 h-7 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center text-xs font-bold">
                                        {idx + 1}
                                      </span>
                                      {rep.rep}
                                    </div>
                                  </td>
                                  <td rowSpan={products.length} className="p-3 text-gray-600 bg-blue-50/50 border-b text-right align-top">
                                    📍 {rep.region}
                                  </td>
                                </>
                              ) : null}
                              <td className="p-3 text-right text-gray-700">💊 {product}</td>
                              <td className="p-3 text-center font-semibold text-gray-700">{sales.count}</td>
                              <td className="p-3 text-center font-semibold text-emerald-600">{sales.total.toFixed(2)}</td>
                            </tr>
                          ))}
                          <tr className="bg-gray-50/80 border-b-2 border-gray-200">
                            <td colSpan={3} className="p-3 text-right font-bold text-gray-600 text-sm">
                              إجمالي {rep.rep}
                            </td>
                            <td className="p-3 text-center font-bold text-gray-500 text-sm">—</td>
                            <td className="p-3 text-center font-bold text-blue-600">{rep.total.toFixed(2)}</td>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gradient-to-r from-amber-50 to-yellow-50">
                      <td className="p-4 font-bold text-gray-800 text-lg" colSpan={3}>🏆 المجموع الكلي</td>
                      <td className="p-4 text-center font-bold text-gray-400">—</td>
                      <td className="p-4 text-center font-bold text-emerald-700 text-lg">{totalSales.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-12 text-center">
              <p className="text-gray-400">لا توجد بيانات للعرض</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}