import { useEffect, useRef, useState } from "react";

/**
 * Reports whether a node is in (or near) the viewport.
 *
 * With `once`, it latches on first sight -- right for a thumbnail, which is
 * worth keeping rather than re-decoding on every scroll. Pass `once: false`
 * for a paging sentinel that must keep reporting as content grows under it.
 */
export function useInView<T extends HTMLElement>(rootMargin = "300px", once = true) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || (once && inView)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setInView(visible);
        if (visible && once) observer.disconnect();
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin, once]);

  return { ref, inView };
}
