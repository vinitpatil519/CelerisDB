import { useState } from "react";

import { Button, Demo, prefersReducedMotion, useInterval } from "../kit";
import "./RetryTimeline.css";

type Tone = "ok" | "warn" | "bad";

interface Attempt {
  node: string;
  result: string;
  tone: Tone;
  note: string;
  wait?: string;
}

interface Scenario {
  id: string;
  label: string;
  caption: string;
  attempts: Attempt[];
  final: { tone: Tone; text: string };
}

const MUTATION_ID = "7d1c0e5a-4b8e-4f0a-9a52-3c1f6e2b9d10";

const SCENARIOS: Scenario[] = [
  {
    id: "redirect",
    label: "Leader moved",
    caption: "A 421 is a routing answer, not a failure. Notice that the next attempt starts at once and the mutation ID does not change.",
    attempts: [
      {
        node: "node-a",
        result: "421 not_leader",
        tone: "warn",
        note: "node-a is not the leader of this key's replica set. Nothing was applied. The client moves to the next node without sleeping.",
      },
      {
        node: "node-b",
        result: "200 OK, version 18",
        tone: "ok",
        note: "node-b is the leader and commits the write. The client remembers node-b as the preferred node and stores the session token from the response.",
      },
    ],
    final: { tone: "ok", text: "put() resolves with version 18. The caller never saw the redirect." },
  },
  {
    id: "transient",
    label: "Transient 503",
    caption: "Some 503 codes (such as proposal_lost) guarantee that nothing was applied, so retrying is always safe. A short pause grows with each attempt.",
    attempts: [
      {
        node: "node-a",
        result: "503 proposal_lost",
        tone: "warn",
        note: "The leader changed while the proposal was in flight. The node states that the write was not applied.",
        wait: "pause about 100 ms",
      },
      {
        node: "node-b",
        result: "421 not_leader",
        tone: "warn",
        note: "node-b is a follower and points at the new leader. No pause for redirects.",
      },
      {
        node: "node-c",
        result: "200 OK, version 19",
        tone: "ok",
        note: "node-c is the new leader and commits the write.",
      },
    ],
    final: { tone: "ok", text: "put() resolves with version 19 after three attempts, all with the same mutation ID." },
  },
  {
    id: "lost",
    label: "Reply lost",
    caption: "The hard case: the write may have committed but the answer never arrived. The same ID lets the new leader recognise it and not write twice.",
    attempts: [
      {
        node: "node-a",
        result: "connection reset",
        tone: "bad",
        note: "The request was sent, then the connection dropped. The client cannot tell whether node-a committed it, so it remembers that the outcome might be unknown.",
        wait: "pause about 100 ms",
      },
      {
        node: "node-b",
        result: "200 OK, deduplicated: true",
        tone: "ok",
        note: "node-b (now the leader) already has this mutation ID in its committed log, so it returns the original version and writes nothing new.",
      },
    ],
    final: { tone: "ok", text: "put() resolves with deduplicated = true. Without the mutation ID this retry could have written the value twice." },
  },
  {
    id: "down",
    label: "Nothing reachable",
    caption: "When every attempt fails before a connection opens, the client knows the request never reached a node and reports a clean failure.",
    attempts: [
      { node: "node-a", result: "connection refused", tone: "bad", note: "The TCP connection could not be opened, so the request was never sent.", wait: "pause about 100 ms" },
      { node: "node-b", result: "connection refused", tone: "bad", note: "Same on the next node.", wait: "pause about 200 ms" },
      { node: "node-c", result: "connection refused", tone: "bad", note: "Same on the third node.", wait: "pause about 300 ms" },
      { node: "node-a", result: "connection refused", tone: "bad", note: "Fourth and last attempt (the default is 4).", wait: "pause about 400 ms" },
    ],
    final: { tone: "bad", text: "The call fails with an unreachable error and outcome not_applied. It is safe to treat as failed." },
  },
  {
    id: "unknown",
    label: "Timeouts",
    caption: "If requests may have reached a node but nothing confirms them, the client refuses to call it a failure. You resolve it with the mutation ID.",
    attempts: [
      { node: "node-a", result: "timeout after send", tone: "bad", note: "The request was sent and no answer came within the timeout. It might have committed.", wait: "pause about 100 ms" },
      { node: "node-b", result: "timeout after send", tone: "bad", note: "Same again, on the next node.", wait: "pause about 200 ms" },
      { node: "node-c", result: "timeout after send", tone: "bad", note: "And again.", wait: "pause about 300 ms" },
      { node: "node-a", result: "timeout after send", tone: "bad", note: "Last attempt used up.", wait: "pause about 400 ms" },
    ],
    final: {
      tone: "warn",
      text: "The call fails with OutcomeUnknown carrying the mutation ID. Ask mutation status, or retry with that same ID.",
    },
  },
];

export default function RetryTimeline() {
  const [sid, setSid] = useState("redirect");
  const scenario = SCENARIOS.find((s) => s.id === sid) ?? SCENARIOS[0]!;
  const total = scenario.attempts.length;
  // Start fully revealed so the static page and reduced-motion users see the end state.
  const [shown, setShown] = useState(total);
  const [playing, setPlaying] = useState(false);

  useInterval(
    () => {
      if (shown >= total) {
        setPlaying(false);
        return;
      }
      setShown(shown + 1);
    },
    1100,
    playing,
  );

  const choose = (id: string) => {
    const next = SCENARIOS.find((s) => s.id === id);
    if (!next) return;
    setSid(id);
    setPlaying(false);
    setShown(next.attempts.length);
  };

  const play = () => {
    if (prefersReducedMotion()) {
      setShown(total);
      return;
    }
    setShown(0);
    setPlaying(true);
  };

  const step = () => {
    setPlaying(false);
    setShown((n) => (n >= total ? 1 : n + 1));
  };

  const done = shown >= total;

  return (
    <Demo
      title="What a write does when things go wrong"
      note="Simulation in your browser. It follows the retry rules of the SDKs: 4 attempts by default, rotating through the node list, one mutation ID for the whole call."
      controls={
        <>
          <Button kind="primary" onClick={play}>
            Play
          </Button>
          <Button onClick={step}>Step</Button>
        </>
      }
    >
      <div className="rt-wrap">
        <div className="rt-picker" role="group" aria-label="Scenario">
          {SCENARIOS.map((s) => (
            <Button key={s.id} pressed={s.id === sid} onClick={() => choose(s.id)}>
              {s.label}
            </Button>
          ))}
        </div>
        <div className="rt-id">
          mutation id: <b>{MUTATION_ID}</b> (identical on every attempt)
        </div>
        <ol className="rt-list" aria-live="polite">
          {scenario.attempts.map((a, i) => (
            <li key={`${sid}-${i}`} className={`rt-row ${i < shown ? "rt-on" : ""}`}>
              <span className="rt-num">{i + 1}</span>
              <div>
                <div className="rt-head">
                  <span className="rt-node">{a.node}</span>
                  <span className={`rt-res rt-${a.tone}`}>{a.result}</span>
                  {a.wait ? <span className="rt-wait">{a.wait}</span> : null}
                </div>
                <p className="rt-note">{a.note}</p>
              </div>
            </li>
          ))}
        </ol>
        {done ? <div className={`rt-final rt-${scenario.final.tone}`}>{scenario.final.text}</div> : null}
        <p className="rt-caption">{scenario.caption}</p>
      </div>
    </Demo>
  );
}
