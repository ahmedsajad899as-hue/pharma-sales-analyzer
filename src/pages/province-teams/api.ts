// طلبات صفحة «فرق المحافظات» — غلاف رفيع يوحّد الهيدر وقراءة رسالة الخطأ.

const BASE = '/api/province-teams';

export class ApiError extends Error {
  code?: string;
  conflicts?: { repName: string | null; kind: 'all' | 'items'; itemNames?: string[] }[];
  constructor(message: string, code?: string, conflicts?: ApiError['conflicts']) {
    super(message); this.code = code; this.conflicts = conflicts;
  }
}

export async function api<T = any>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* رد بلا JSON */ }
  if (!res.ok || body?.success === false) {
    throw new ApiError(body?.message || body?.error || `فشل الطلب (${res.status})`, body?.code, body?.conflicts);
  }
  return body as T;
}

export const jsonBody = (data: unknown): RequestInit => ({ body: JSON.stringify(data) });
