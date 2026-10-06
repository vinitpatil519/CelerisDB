import { useEffect, useRef } from "react";

import { Architecture } from "./blocks/Architecture";
import { Band } from "./blocks/Band";
import { Cap } from "./blocks/Cap";
import { Cta, Proof } from "./blocks/Closing";
import { Developers } from "./blocks/Developers";
import { Features } from "./blocks/Features";
import { Hero } from "./blocks/Hero";
import { Integrations } from "./blocks/Integrations";
import { Modes } from "./blocks/Modes";
import { Partitions } from "./blocks/Partitions";
import { Footer, Nav } from "./components/kit";
import { revealIn, ScrollTrigger, startSmoothScroll, useGSAP } from "./motion";

export function App() {
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const stop = startSmoothScroll();
    const refresh = () => ScrollTrigger.refresh();
    addEventListener("load", refresh);
    document.fonts?.ready.then(refresh);
    // Late layout shifts (fonts, pin spacers) must not leave stale triggers.
    const late = setTimeout(refresh, 800);
    return () => {
      clearTimeout(late);
      removeEventListener("load", refresh);
      stop();
    };
  }, []);

  // Scroll reveals for every [data-reveal] element on the page.
  useGSAP(() => main.current && revealIn(main.current), { scope: main });

  return (
    <>
      <a className="skip" href="#start">
        Skip to install
      </a>
      <Nav />
      <main ref={main}>
        <Hero />
        <Band />
        <Cap />
        <Modes />
        <Architecture />
        <Partitions />
        <Features />
        <Integrations />
        <Developers />
        <Proof />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
