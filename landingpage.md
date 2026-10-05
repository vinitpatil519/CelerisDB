# Landing Page Specification

## Creative direction

The site should take the **technical confidence, product clarity and enterprise polish** of Aerospike as inspiration, but become dramatically more interactive: a cinematic, dark, wireframe-driven database story with scroll-controlled architecture diagrams and a visual explanation of consistency modes.

Aerospike's own architecture messaging emphasizes a cluster-aware client, shared-nothing clustering, partitioning, replication, rebalancing and strong/AP consistency modes. ParadoxDB should use those concepts as the narrative foundation, not copy its branding or layout. citeturn270962search2turn270962search1

## Visual language

- near-black background.
- cool gray/white typography.
- electric cyan as the primary data-flow accent.
- amber for warnings/tradeoffs.
- crimson only for failure states.
- thin 1px wireframe lines.
- glass panels with subtle blur.
- large technical monospace labels.
- oversized numeric metrics.

No paid visual assets are required. Use SVG, CSS gradients, canvas and generated geometry.

## Page structure

### 01 — Hero

Headline:

> **A database that makes distributed-system tradeoffs programmable.**

Subheadline:

> Partition-tolerant. Low latency. Developer-first. Choose how each operation balances consistency, availability and failure behavior.

CTAs:

- `Install ParadoxDB`
- `Explore Architecture`

Hero visual: a floating 3-node topology with a data packet continuously moving through the cluster. The nodes are connected by animated vector lines.

### 02 — The CAP problem

Start with the triangle. On scroll, the triangle becomes a live network partition visualization. The site explicitly explains that CAP is not being "broken".

Copy:

> **We don't break CAP. We make the tradeoff explicit.**

### 03 — Consistency dial

A huge interactive dial with five modes:

`STRICT` → `SESSION` → `BOUNDED` → `AVAILABLE` → `EVENTUAL`

Each step changes:

- expected availability.
- stale-read risk.
- coordination cost.
- typical use case.

### 04 — One request, inside the database

Animate one GET request through:

```text
React
 ↓
SDK
 ↓
Router
 ↓
Partition 217
 ↓
Replica
 ↓
Block cache
 ↓
Value
```

Show the path as a luminous wire moving through a technical schematic.

### 05 — 4096 logical partitions

Show thousands of tiny points in a circular partition ring. Scroll changes the physical node count from 3 to 4, visually moving only the partitions that need migration.

### 06 — Storage engine

Exploded wireframe:

`WAL → Memtable → Segments → Bloom Filter → Block Cache → Compaction`

### 07 — The partition happens

This is the signature section.

Two halves of the cluster separate with a slowly increasing distance. Network links break. On the strict side, operations display `WAITING FOR QUORUM`. On the available side, operations display `ACCEPTED LOCALLY`.

Then the network heals. A reconciliation wave travels across the cluster.

### 08 — Conflict resolution

Show two divergent versions of a record. Then visualize:

- causal ordering.
- concurrent updates.
- deterministic LWW.
- merge policy.
- converged state.

### 09 — Realtime React

Show a React component receiving WebSocket events with a live state change.

Code panel:

```tsx
const { data } = useParadox('orders/123', {
  consistency: 'SESSION'
});
```

### 10 — Deploy anywhere

Animated topology morphs:

`Laptop → Docker → Kubernetes → AWS`

No cloud lock-in message.

### 11 — Install now

Linux/macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/paradoxdb/main/install.sh | sh
paradoxdb init
paradoxdb start
```

Windows:

```powershell
irm https://raw.githubusercontent.com/<org>/paradoxdb/main/install.ps1 | iex
paradoxdb init
paradoxdb start
```

Docker:

```bash
docker run --rm -p 8080:8080 -p 7000:7000 ghcr.io/<org>/paradoxdb:latest
```

### 12 — Final CTA

Headline:

> **Build for failure. Choose your consistency. Ship anyway.**

Buttons: `GitHub`, `Read the Architecture`, `Start Local Cluster`.

## Interaction details

### Sticky hero topology

The topology stays pinned while copy transitions through three states: route, replicate, recover.

### Scroll progress rail

A thin left rail labels sections: `CAP`, `ROUTE`, `PARTITION`, `STORE`, `RECONCILE`, `DEPLOY`.

### Cursor behavior

Subtle pointer light over technical panels. Disable on touch devices.

### Hover cards

Node hover shows:

```text
node-b
zone: ap-south-1b
partitions: 1366–2730
replication: RF3
status: healthy
```

## Accessibility

- semantic HTML.
- keyboard navigable code examples.
- contrast-compliant text.
- reduced motion mode.
- captions/transcripts where animation communicates meaning.

## Technology recommendation

Use Next.js or Vite + React + TypeScript. For a static marketing site, Vite or Next.js static export is enough. No paid backend is needed for the landing page.

Recommended structure:

```text
website/
├── src/
│   ├── sections/
│   ├── components/
│   ├── animations/
│   ├── diagrams/
│   ├── data/
│   └── styles/
├── public/
└── package.json
```

## GSAP implementation pattern

```ts
const tl = gsap.timeline({
  scrollTrigger: {
    trigger: section,
    start: 'top top',
    end: '+=1800',
    scrub: true,
    pin: true,
  }
});

tl.to(nodeA, { x: -120, y: 40 })
  .to(linkAB, { opacity: 0 }, '<')
  .to(statusStrict, { opacity: 1 })
  .to(statusAvailable, { opacity: 1 }, '<');
```

## Lenis integration

Initialize Lenis once at the app shell and keep GSAP's ticker in sync. Do not create a new Lenis instance per section.

## Wireframe diagram rules

All architecture diagrams should be generated from reusable SVG primitives:

- Node.
- Rack.
- AZ.
- Packet.
- Link.
- Partition.
- Storage layer.
- Failure line.
- State badge.

This makes the site maintainable instead of drawing one giant SVG.
