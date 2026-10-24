import { createContext, useContext } from 'react';

// الصفحات تبقى مركَّبة مخفية (keep-alive في App.tsx) — هذا يُخبر الصفحة هل هي المعروضة الآن،
// لمن يريد إعادة ضبط حالة عند مغادرة الصفحة.
export const PageActiveContext = createContext(true);
export const usePageActive = () => useContext(PageActiveContext);
