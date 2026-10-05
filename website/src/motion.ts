/**
 * One Lenis instance for the whole page, driven by GSAP's ticker so smooth
 * scrolling and ScrollTrigger stay in step. Reduced-motion users get native
 * scrolling and no scrubbed animation.
 */

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useEffect, useState } from "react";

gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

let lenis: Lenis | null = null;

/** Starts smooth scrolling once; returns a cleanup function. */
export function startSmoothScroll(): () => void {
  if (prefersReducedMotion() || lenis) return () => {};
  const instance = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis = instance;
  instance.on("scroll", ScrollTrigger.update);
  const tick = (time: number) => instance.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);
  return () => {
    gsap.ticker.remove(tick);
    instance.destroy();
    lenis = null;
  };
}

/** Scrolls to an element, through Lenis when it runs. */
export function scrollToId(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  if (lenis) lenis.scrollTo(target, { offset: -8 });
  else target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  target.focus({ preventScroll: true });
}

/**
 * Scroll progress (0..1) of `ref` through the viewport: 0 when its top
 * reaches the top of the screen, 1 when its bottom does. Static at 1 for
 * reduced motion, so the final state is shown.
 */
export function useScrollProgress(ref: React.RefObject<HTMLElement | null>, steps = 0): number {
  // Narrow screens do not pin sections (see global.css), so show the end state.
  const reduced = useReducedMotion() || (typeof window !== "undefined" && window.innerWidth <= 960);
  const [progress, setProgress] = useState(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced || !ref.current) {
      setProgress(1);
      return;
    }
    const trigger = ScrollTrigger.create({
      trigger: ref.current,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => {
        const p = steps > 0 ? Math.round(self.progress * steps) / steps : self.progress;
        setProgress(p);
      },
    });
    return () => trigger.kill();
  }, [ref, reduced, steps]);
  return progress;
}

/** Linear interpolation of `p` between `from` and `to`, clamped to 0..1. */
export function phase(p: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (p - from) / (to - from)));
}
