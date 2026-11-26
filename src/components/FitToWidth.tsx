// ════════════════════════════════════════════════════════════════════════════
// FitToWidth — على الهاتف فقط: يصغّر الجدول (CSS zoom) بقدر ما يلزم كي تظهر كل أعمدته في عرض
// الشاشة، بنفس التصميم والترتيب (صورة شاشة واحدة بلا تمرير جانبي). الحاسوب لا يتغيّر أبداً.
//
// الحساب: نضع المحتوى بعرض الحاوية (zoom = 1) فتلتف الخلايا القابلة للالتفاف ويبقى ما عليه
// nowrap، ثم نقيس عرضه الأدنى الفعلي (scrollWidth) ونصغّره إلى عرض الحاوية: أكبر خط ممكن.
// يُعاد الحساب مع كل رسم ومع تغيّر عرض الشاشة (تدوير الهاتف) أو حجم المحتوى.
// ════════════════════════════════════════════════════════════════════════════

import type React from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';

interface Props {
  children: React.ReactNode;
  /** تفعيل خارج الهاتف (افتراضياً الهاتف فقط). */
  force?: boolean;
  /** نمط الحاوية على الحاسوب فقط. */
  style?: React.CSSProperties;
}

export default function FitToWidth({ children, force, style }: Props) {
  const mobile = useIsMobile();
  const on = force || mobile;
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);

  const fit = () => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const s = i.style as CSSStyleDeclaration & { zoom: string };
    if (!on) { s.zoom = ''; s.width = ''; return; }
    const avail = o.clientWidth;
    if (!avail) return;
    s.zoom = '1';
    s.width = `${avail}px`;
    let need = i.scrollWidth;
    for (const c of Array.from(i.children)) need = Math.max(need, (c as HTMLElement).scrollWidth || 0);
    if (need <= avail + 1) { s.zoom = ''; s.width = ''; return; }
    s.width = `${need}px`;
    s.zoom = String(Math.floor((avail / need) * 1000) / 1000);
  };

  // بعد كل رسم: المحتوى (صفوف فُتحت/فلتر تغيّر) قد يغيّر العرض اللازم
  useLayoutEffect(fit);

  useEffect(() => {
    if (!on) return;
    const o = outer.current, i = inner.current;
    if (!o || !i || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    let lastW = o.clientWidth, lastH = i.scrollHeight;
    const ro = new ResizeObserver(() => {
      // الارتفاع يتغيّر مع zoom نفسه؛ نعيد الحساب فقط إن تغيّر عرض الحاوية أو ارتفاع المحتوى فعلاً
      const w = o.clientWidth, h = i.scrollHeight;
      if (w === lastW && Math.abs(h - lastH) < 2) return;
      lastW = w; lastH = h;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(o);
    ro.observe(i);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  // clip لا hidden: hidden يجعلها حاوية تمرير فيتعطّل رأس الجدول الثابت (sticky) داخل النوافذ.
  // style يُطبَّق على الحاسوب فقط (مثل overflowX: auto للجدول العريض) — شكله هناك كما كان.
  return (
    <div ref={outer} style={on ? { width: '100%', overflowX: 'clip' } : style}>
      <div ref={inner}>{children}</div>
    </div>
  );
}
