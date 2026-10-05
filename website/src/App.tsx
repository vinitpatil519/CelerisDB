import { useEffect } from "react";

import { Nav, ProgressRail, usePointerLight } from "./components/chrome";
import { ScrollTrigger, startSmoothScroll } from "./motion";
import { Deploy, FinalCta, Install, Realtime } from "./sections/Developer";
import { Partitions, Storage } from "./sections/Engine";
import { Conflicts, Split } from "./sections/Failure";
import { Hero } from "./sections/Hero";
import { Cap, Dial, Request } from "./sections/Story";

export function App() {
  useEffect(() => {
    const stop = startSmoothScroll();
    // Layout settles after fonts and images; recompute trigger positions.
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("load", refresh);
    return () => {
      window.removeEventListener("load", refresh);
      stop();
    };
  }, []);
  usePointerLight();

  return (
    <>
      <a className="skip" href="#install">
        Skip to install
      </a>
      <div className="backdrop" aria-hidden="true" />
      <Nav />
      <ProgressRail />
      <main>
        <Hero />
        <Cap />
        <Dial />
        <Request />
        <Partitions />
        <Storage />
        <Split />
        <Conflicts />
        <Realtime />
        <Deploy />
        <Install />
        <FinalCta />
      </main>
    </>
  );
}
