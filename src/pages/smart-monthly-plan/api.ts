import type { AmbiguousGroup, AreaWithDoctors, PharmacyLookupHit, SmartPlan, SmartPlanCandidate, SmartPlanUpload, SurveyPharmacyRef, UploadKind } from './types';

const API = import.meta.env.VITE_API_URL || '';

async function req(token: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API}/api/smart-monthly-plans${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) throw new Error(json?.error || 'حدث خطأ غير متوقّع');
  return json;
}

function jsonReq(token: string, path: string, method: string, body?: unknown) {
  return req(token, path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export const smartPlanApi = {
  list: (token: string) => req(token, '/') as Promise<{ plans: SmartPlan[] }>,

  create: (token: string, data: { scientificRepId: number; month: number; year: number; title?: string; targetDoctorCount?: number }) =>
    jsonReq(token, '/', 'POST', data) as Promise<{ plan: SmartPlan }>,

  getOne: (token: string, id: number) =>
    req(token, `/${id}`) as Promise<{ plan: SmartPlan; uploads: SmartPlanUpload[]; candidates: SmartPlanCandidate[] }>,

  update: (token: string, id: number, data: Partial<Pick<SmartPlan, 'title' | 'targetDoctorCount' | 'ratioConfig'>>) =>
    jsonReq(token, `/${id}`, 'PATCH', data) as Promise<{ plan: SmartPlan }>,

  remove: (token: string, id: number) => req(token, `/${id}`, { method: 'DELETE' }),

  uploadFile: async (token: string, id: number, kind: UploadKind, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req(token, `/${id}/uploads/${kind}`, { method: 'POST', body: fd }) as Promise<{
      rowCount: number; matched?: number; created?: number; pharmacyNamesCount?: number; linkedCount?: number;
    }>;
  },

  clearUpload: (token: string, id: number, kind: UploadKind) =>
    req(token, `/${id}/uploads/${kind}`, { method: 'DELETE' }),

  getAreaDoctors: (token: string, id: number) =>
    req(token, `/${id}/area-doctors`) as Promise<{
      areas: AreaWithDoctors[]; surveyPharmacies: SurveyPharmacyRef[];
      hasOpenPharmaciesFile: boolean; openPharmacyNamesCount: number;
    }>,

  saveDoctorSelection: (token: string, id: number, selectedKeys: string[]) =>
    jsonReq(token, `/${id}/doctor-selection`, 'PUT', { selectedKeys }) as Promise<{ selectedCount: number }>,

  savePharmacyLink: (token: string, id: number, data: { fromName: string; areaName: string | null; toName: string | null }) =>
    jsonReq(token, `/${id}/pharmacy-links`, 'POST', data),

  removePharmacyLink: (token: string, id: number, data: { fromName: string; areaName: string | null }) =>
    jsonReq(token, `/${id}/pharmacy-links`, 'DELETE', data),

  registerPharmacyInSurvey: (token: string, id: number, data: { name: string; areaName: string }) =>
    jsonReq(token, `/${id}/pharmacies/register`, 'POST', data) as Promise<{
      duplicate: boolean; pharmacy: { id: number; name: string; areaName: string | null };
    }>,

  registerAllOpenPharmacies: (token: string, id: number) =>
    req(token, `/${id}/pharmacies/register-all`, { method: 'POST' }) as Promise<{
      created: number; duplicate: number; failed: number; total: number; names: string[];
    }>,

  lookupPharmacy: (token: string, id: number, name: string) =>
    req(token, `/${id}/pharmacy-lookup?name=${encodeURIComponent(name)}`) as Promise<{
      results: PharmacyLookupHit[]; repAreaNames: string[];
    }>,

  renamePharmacy: (token: string, id: number, data: { areaId: number; oldName: string; newName: string }) =>
    jsonReq(token, `/${id}/pharmacies/rename`, 'POST', data) as Promise<{ doctors: number; pharmacyRows: number; visits: number }>,

  mergePharmacies: (token: string, id: number, data: { areaId: number; keepName: string; mergeNames: string[] }) =>
    jsonReq(token, `/${id}/pharmacies/merge`, 'POST', data) as Promise<{ doctors: number; pharmacyRows: number; visits: number }>,

  resolve: (token: string, id: number) =>
    req(token, `/${id}/resolve`, { method: 'POST' }) as Promise<{ linked: number; exact: number; ask: number; created: number }>,

  getAmbiguous: (token: string, id: number) =>
    req(token, `/${id}/ambiguous`) as Promise<{ groups: AmbiguousGroup[] }>,

  resolveAi: (token: string, id: number) =>
    req(token, `/${id}/resolve/ai`, { method: 'POST' }) as Promise<{ resolved: number; newDoctors: number; total: number; timedOut: boolean }>,

  confirmMatches: (token: string, id: number, picks: { candidateId: number; doctorId: number | null }[]) =>
    jsonReq(token, `/${id}/resolve/confirm`, 'POST', { picks }) as Promise<{ confirmed: number; failed: number }>,

  compute: (token: string, id: number) =>
    req(token, `/${id}/compute`, { method: 'POST' }) as Promise<{ summary: any[]; unassignableCount: number }>,

  updateCandidate: (token: string, id: number, candidateId: number, data: { selected?: boolean; assignedBucketKey?: string | null }) =>
    jsonReq(token, `/${id}/candidates/${candidateId}`, 'PATCH', data) as Promise<{ candidate: SmartPlanCandidate }>,

  markExported: (token: string, id: number) => req(token, `/${id}/mark-exported`, { method: 'POST' }),
};
