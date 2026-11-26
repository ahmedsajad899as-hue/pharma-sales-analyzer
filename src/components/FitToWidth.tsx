// ════════════════════════════════════════════════════════════════════════════
// FitToWidth — على الهاتف فقط: يصغّر الجدول (CSS zoom) بقدر ما يلزم كي تظهر كل أعمدته في عرض
// الشاشة، بنفس التصميم والترتيب (صورة شاشة واحدة بلا تمرير جانبي). الحاسوب لا يتغيّر أبداً.
//
// الحساب: نضع المحتوى بعرض الحاوية (zoom = 1) فتلتف الخلايا القابلة للالتفاف ويبقى ما عليه
// nowrap، ثم نقيس عرضه الأدنى الفعلي (scrollWidth) ونصغّره إلى عرض الحاوية: أكبر خط ممكن.
// الخط المصغَّر يُثخَّن قليلاً (text-stroke) كي يبقى واضحاً.
//
// تكبير/تصغير: التطبيق يمنع تكبير المتصفح (maximum-scale=1)، فالجدول نفسه يقبل قرص الإصبعين
// وأزرار ＋/－/ملاءمة. فوق حجم الملاءمة يصير التمرير الجانبي متاحاً، و«ملاءمة» تعيده لشاشة واحدة.
// ════════════════════════════════════════════════════════════════════════════

import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';

interface Props {
  children: React.ReactNode;
  /** تفعيل خارج الهاتف (افتراضياً الهاتف فقط). */
  force?: boolean;
  /** نمط الحاوية على الحاسوب فقط. */
  style?: React.CSSProperties;
}

const MAX_ZOOM = 1.6; // أقصى تكبير نسبةً للحجم الطبيعي للخط

export default function FitToWidth({ children, force, style }: Props) {
  const mobile = useIsMobile();
  const on = force || mobile;
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const fitZoom = useRef(1);   // zoom الملاءمة (≤ 1)
  const userScale = useRef(1); // تكبير المستخدم فوق الملاءمة (1 = شاشة واحدة)
  const [ui, setUi] = useState({ shrunk: false, zoomed: false });

  // يطبّق zoom = الملاءمة × تكبير المستخدم، بلا إعادة قياس
  const apply = () => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const s = i.style as CSSStyleDeclaration & { zoom: string; webkitTextStroke: string };
    const fz = fitZoom.current;
    userScale.current = Math.min(Math.max(userScale.current, 1), MAX_ZOOM / fz);
    const z = fz * userScale.current;
    const zoomed = userScale.current > 1.01;
    s.zoom = z < 0.999 || z > 1.001 ? String(Math.round(z * 1000) / 1000) : '';
    // تثخين خفيف للخط المصغَّر: سُمكه بعد التصغير ≈ 0.25px على الشاشة
    s.webkitTextStroke = z < 0.95 ? `${Math.min(0.5, 0.25 / z).toFixed(2)}px` : '';
    o.style.overflowX = zoomed ? 'auto' : 'clip';
    setUi(prev => (prev.shrunk === fz < 0.999 && prev.zoomed === zoomed ? prev : { shrunk: fz < 0.999, zoomed }));
  };

  const fit = () => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const s = i.style as CSSStyleDeclaration & { zoom: string; webkitTextStroke: string };
    if (!on) { s.zoom = ''; s.width = ''; s.webkitTextStroke = ''; o.style.overflowX = ''; return; }
    const avail = o.clientWidth;
    if (!avail) return;
    s.zoom = '1';
    s.width = `${avail}px`;
    let need = i.scrollWidth;
    for (const c of Array.from(i.children)) need = Math.max(need, (c as HTMLElement).scrollWidth || 0);
    if (need <= avail + 1) {
      s.width = '';
      fitZoom.current = 1;
    } else {
      s.width = `${need}px`;
      fitZoom.current = Math.floor((avail / need) * 1000) / 1000;
    }
    apply();
  };

  // بعد كل رسم: المحتوى (صفوف فُتحت/فلتر تغيّر) قد يغيّر العرض اللازم
  useLayoutEffect(fit);

  useEffect(() => {
    if (!on) return;
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    let raf = 0;

    // إعادة الملاءمة عند تغيّر عرض الشاشة (تدوير) أو ارتفاع المحتوى فعلاً
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      let lastW = o.clientWidth, lastH = i.scrollHeight;
      ro = new ResizeObserver(() => {
        const w = o.clientWidth, h = i.scrollHeight;
        if (w === lastW && Math.abs(h - lastH) < 2) return;
        lastW = w; lastH = h;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(fit);
      });
      ro.observe(o);
      ro.observe(i);
    }

    // قرص الإصبعين داخل الجدول = تكبير/تصغير
    let d0 = 0, s0 = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => { if (e.touches.length === 2) { d0 = dist(e.touches); s0 = userScale.current; } };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault();
      userScale.current = s0 * (dist(e.touches) / d0);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2) d0 = 0; };
    o.addEventListener('touchstart', onStart, { passive: true });
    o.addEventListener('touchmove', onMove, { passive: false });
    o.addEventListener('touchend', onEnd, { passive: true });
    o.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(raf);
      o.removeEventListener('touchstart', onStart);
      o.removeEventListener('touchmove', onMove);
      o.removeEventListener('touchend', onEnd);
      o.removeEventListener('touchcancel', onEnd);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  const step = (f: number) => { userScale.current *= f; apply(); };
  const reset = () => { userScale.current = 1; apply(); if (outer.current) outer.current.scrollLeft = 0; };
  const btn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', color: '#334155', borderRadius: 999, minWidth: 30, height: 26, padding: '0 9px', fontSize: 13, fontWeight: 800, cursor: 'pointer', lineHeight: 1 };

  // clip لا hidden: hidden يجعلها حاوية تمرير فيتعطّل رأس الجدول الثابت (sticky) داخل النوافذ.
  // style يُطبَّق على الحاسوب فقط (مثل overflowX: auto للجدول العريض) — شكله هناك كما كان.
  return (
    <>
      {on && ui.shrunk && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', padding: '4px 0', direction: 'rtl' }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{ui.zoomed ? 'اسحب جانبياً للتنقل' : 'قرّب بإصبعين للتكبير'}</span>
          <button type="button" style={btn} onClick={() => step(1 / 1.25)} aria-label="تصغير">－</button>
          <button type="button" style={btn} onClick={() => step(1.25)} aria-label="تكبير">＋</button>
          {ui.zoomed && <button type="button" style={{ ...btn, background: '#0f172a', color: '#fff', borderColor: '#0f172a' }} onClick={reset}>ملاءمة الشاشة</button>}
        </div>
      )}
      <div ref={outer} style={on ? { width: '100%', overflowX: 'clip' } : style}>
        <div ref={inner}>{children}</div>
      </div>
    </>
  );
}
