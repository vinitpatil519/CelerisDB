/**
 * Motion foundation: one Lenis instance driven by GSAP's ticker, the GSAP
 * plugins the page uses, and small helpers shared by every section.
 * Reduced-motion users get native scrolling and final states.
 */

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";
import { useEffect, useState } from "react";

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, MotionPathPlugin, ScrambleTextPlugin, useGSAP);

export { gsap, ScrollTrigger, SplitText, useGSAP };

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

export function startSmoothScroll(): () => void {
  if (prefersReducedMotion() || lenis) return () => {};
  const instance = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 0.9 });
  lenis = instance;
  (window as unknown as { __lenis?: Lenis }).__lenis = instance;
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

export function scrollToId(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  if (lenis) lenis.scrollTo(target, { offset: -40, duration: 1.4 });
  else target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** Click handler for in-page links that scroll through Lenis. */
export function jump(id: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    scrollToId(id);
    history.replaceState(null, "", `#${id}`);
  };
}

/**
 * Reveals every `[data-reveal]` element inside `scope` as it scrolls in:
 * `lines` splits headings into masked lines, `fade` lifts and fades,
 * `draw` draws SVG strokes.
 */
export function revealIn(scope: Element) {
  if (prefersReducedMotion()) return;
  scope.querySelectorAll<HTMLElement>("[data-reveal='lines']").forEach((el) => {
    const split = SplitText.create(el, { type: "lines,words", mask: "lines", wordsClass: "word" });
    el.classList.add("is-split");
    gsap.from(split.lines, {
      yPercent: 110,
      opacity: 0,
      duration: 1.1,
      ease: "expo.out",
      stagger: 0.08,
      scrollTrigger: { trigger: el, start: "top 85%", once: true },
    });
  });
  scope.querySelectorAll<HTMLElement>("[data-reveal='fade']").forEach((el) => {
    gsap.from(el, {
      y: 20,
      opacity: 0,
      duration: 0.9,
      ease: "power3.out",
      delay: Number(el.dataset.delay ?? 0),
      scrollTrigger: { trigger: el, start: "top 88%", once: true },
    });
  });
  scope.querySelectorAll<SVGElement>("[data-reveal='draw']").forEach((el) => {
    gsap.from(el, {
      drawSVG: "0%",
      duration: 1.8,
      ease: "power2.inOut",
      scrollTrigger: { trigger: el, start: "top 85%", once: true },
    });
  });
}

/** Lerp helper. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
