export function formatCurrency(value: number, currency: 'IQD' | 'USD' = 'IQD'): string {
  const locale = currency === 'IQD' ? 'ar-IQ-u-nu-latn' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'IQD' ? 0 : 2
  }).format(value);
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn').format(date);
}

export function calculateTotal(items: any[], field: string): number {
  return items.reduce((sum, item) => sum + (item[field] || 0), 0);
}