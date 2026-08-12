import { useCallback, useEffect, useState } from "react";

/**
 * Reports whether a node is in (or near) the viewport.
 *
 * With `once`, it latches on first sight -- right for a thumbnail, which is
 * worth keeping rather than re-decoding on every scroll. Pass `once: false`
 * for a paging sentinel that must keep reporting as content grows under it.
 *
 * The returned `ref` is a callback ref on purpose: a sentinel is unmounted and
 * remounted as its grid is filtered, and a plain ref object would leave the
 * observer watching the old, detached node.
 */
export function useInView<T extends HTMLElement>(rootMargin = "300px", once = true) {
  const [node, setNode] = useState<T | null>(null);
  const [inView, setInView] = useState(false);

  const ref = useCallback((next: T | null) => setNode(next), []);

  useEffect(() => {
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
  }, [node, inView, rootMargin, once]);

  return { ref, inView };
}
