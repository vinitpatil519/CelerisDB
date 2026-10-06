import { useEffect, useRef } from "react";

import { Nav, ScrollProgress } from "./components/ui";
import { prefersReducedMotion, ScrollTrigger, startSmoothScroll } from "./motion";
import { Developers } from "./sections/Developers";
import { Hero } from "./sections/Hero";
import { Journey } from "./sections/Journey";
import { Modes } from "./sections/Modes";
import { Proof } from "./sections/Proof";
import { Resilience } from "./sections/Resilience";

/** A soft light that trails the pointer across the page (fine pointers only). */
function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches || prefersReducedMotion()) return;
    let x = innerWidth / 2;
    let y = innerHeight / 2;
    let tx = x;
    let ty = y;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
    };
    const loop = () => {
      x += (tx - x) * 0.12;
      y += (ty - y) * 0.12;
      ref.current?.style.setProperty("transform", `translate3d(${x - 300}px, ${y - 300}px, 0)`);
      raf = requestAnimationFrame(loop);
    };
    addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => {
      removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);
  return <div className="cursor-glow" ref={ref} aria-hidden="true" />;
}

export function App() {
  useEffect(() => {
    const stop = startSmoothScroll();
    const refresh = () => ScrollTrigger.refresh();
    addEventListener("load", refresh);
    document.fonts?.ready.then(refresh);
    return () => {
      removeEventListener("load", refresh);
      stop();
    };
  }, []);

  return (
    <>
      <a className="skip" href="#start">
        Skip to install
      </a>
      <div className="grain" aria-hidden="true" />
      <CursorGlow />
      <ScrollProgress />
      <Nav />
      <main>
        <Hero />
        <Proof />
        <Modes />
        <Journey />
        <Resilience />
        <Developers />
      </main>
    </>
  );
}
