# Celeris website

The landing page: a dark, scroll-driven tour of how Celeris works, built with
Vite, React, TypeScript, GSAP (ScrollTrigger) and Lenis. It follows
[landingpage.md](../landingpage.md).

```bash
cd website
npm install
npm run dev       # http://localhost:5174
npm run build     # static site in dist/
```

## Structure

```text
src/
  App.tsx              page shell: Lenis + GSAP ticker, nav, chapter rail
  motion.ts            the single Lenis instance, scroll-progress hook, reduced motion
  diagrams/
    primitives.tsx     Node, Link, Packet, Partition, StorageLayer, FailureLine,
                       StateBadge, Zone, Rack: every diagram is built from these
  sections/
    Hero.tsx           01 pinned 3-node topology: route → replicate → recover
    Story.tsx          02 CAP, 03 consistency dial, 04 one request inside
    Engine.tsx         05 4096-partition ring (rendezvous hashing), 06 storage engine
    Failure.tsx        07 the partition happens, 08 conflict resolution
    Developer.tsx      09 realtime React, 10 deploy anywhere, 11 install, 12 CTA
  components/chrome.tsx  nav, progress rail, code blocks, pointer light
  data/site.ts         links, modes, install commands
```

Scroll-driven sections are tall containers with a sticky inner panel; their
state comes from `useScrollProgress`, so the diagrams are plain React and
SVG.

## Accessibility

* Semantic sections and headings. Diagrams have titles and descriptions,
  and captions say in words what each animation shows.
* The dial is a keyboard radio group (arrow keys, Home, End). Tabs use
  arrow keys too. Code blocks are focusable and have copy buttons.
* With `prefers-reduced-motion`, Lenis and scroll scrubbing are off and
  each section shows its final state. Narrow screens unpin sections the
  same way.
* The pointer light is disabled on touch devices.
