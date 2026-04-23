import { useEffect, useRef } from 'react';

/**
 * Registers a 'before-navigate-back' handler that closes the topmost open layer.
 * Pass an ordered array of [condition, closeFn] pairs (highest priority first).
 * The first truthy condition triggers its closeFn and prevents page navigation.
 *
 * Pass `pageId` + `activePage` (from event detail) to restrict tab-back logic
 * to the currently visible page only.
 */
export function useBackHandler(
  layers: Array<[boolean | unknown, () => void]>,
) {
  const layersRef = useRef(layers);
  layersRef.current = layers;

  useEffect(() => {
    const handle = (e: Event) => {
      const ce = e as CustomEvent;
      for (const [cond, close] of layersRef.current) {
        if (cond) { ce.preventDefault(); close(); return; }
      }
    };
    window.addEventListener('before-navigate-back', handle);
    return () => window.removeEventListener('before-navigate-back', handle);
  }, []); // register once; layersRef keeps values fresh
}

/**
 * Same as useBackHandler but only fires when the given pageId matches
 * the activePage carried in the event detail.
 * Use this for tab/sub-page back-navigation so hidden pages don't intercept.
 */
export function usePageBackHandler(
  pageId: string,
  layers: Array<[boolean | unknown, () => void]>,
) {
  const layersRef = useRef(layers);
  layersRef.current = layers;

  useEffect(() => {
    const handle = (e: Event) => {
      const ce = e as CustomEvent;
      if (ce.detail?.activePage !== pageId) return;
      for (const [cond, close] of layersRef.current) {
        if (cond) { ce.preventDefault(); close(); return; }
      }
    };
    window.addEventListener('before-navigate-back', handle);
    return () => window.removeEventListener('before-navigate-back', handle);
  }, [pageId]);
}
