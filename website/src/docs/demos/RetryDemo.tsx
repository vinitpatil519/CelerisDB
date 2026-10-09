import { useState } from "react";

import { Button, Demo } from "../kit";
import "./RetryDemo.css";

type Phase = "idle" | "inflight" | "timeout" | "done";
type Kind = "celeris" | "naive";

interface LogLine {
  who: "client" | "server" | "net";
  text: string;
  tone?: "ok" | "bad" | "warn";
}

const MID = "charge-7f3a";

export default function RetryDemo() {
  const [kind, setKind] = useState<Kind>("celeris");
  const [phase, setPhase] = useState<Phase>("idle");
  const [charges, setCharges] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [verdict, setVerdict] = useState<string | null>(null);

  const say = (l: LogLine) => setLog((x) => [...x, l]);

  const reset = (k: Kind = kind) => {
    setKind(k);
    setPhase("idle");
    setCharges(0);
    setAttempts(0);
    setLog([]);
    setVerdict(null);
  };

  const send = () => {
    setAttempts(1);
    setCharges(1);
    setPhase("inflight");
    say({ who: "client", text: kind === "celeris" ? `charge $40, mutation ID ${MID}` : "charge $40" });
    say({ who: "server", text: "charged the card. Stored the result." });
  };

  const deliver = () => {
    setPhase("done");
    say({ who: "net", text: "response delivered", tone: "ok" });
    say({ who: "client", text: "got the answer, all good.", tone: "ok" });
    setVerdict("Nothing went wrong, so nothing was repeated. Now try again and drop the response.");
  };

  const drop = () => {
    setPhase("timeout");
    say({ who: "net", text: "response lost on the way back", tone: "bad" });
    say({ who: "client", text: "timed out. Did the charge happen? Unknown.", tone: "warn" });
  };

  const retry = () => {
    setAttempts(2);
    setPhase("done");
    if (kind === "celeris") {
      say({ who: "client", text: `retry: charge $40, mutation ID ${MID}` });
      say({ who: "server", text: "seen this ID already. Returns the original result, charges nothing.", tone: "ok" });
      say({ who: "client", text: "got the original answer, deduplicated: true.", tone: "ok" });
      setVerdict("Safe. The retry carried the same mutation ID, so the server recognised it and replayed the first answer.");
    } else {
      setCharges(2);
      say({ who: "client", text: "retry: charge $40" });
      say({ who: "server", text: "no way to know this is a repeat. Charges again.", tone: "bad" });
      setVerdict("Double charge. Without an ID that survives the retry, the server cannot tell a retry from a new order.");
    }
  };

  const ask = () => {
    say({ who: "client", text: `ask: did ${MID} commit?` });
    say({ who: "server", text: "yes, committed. Here is the result.", tone: "ok" });
    setPhase("done");
    setVerdict("You can also ask instead of retrying: the outcome of a mutation ID is always answerable.");
  };

  const bad = charges > 1;

  return (
    <Demo
      title="Why a retry is safe"
      note="Simulated in your browser. A single client and server, with a network that can lose the reply."
      controls={<Button onClick={() => reset()}>Reset</Button>}
    >
      <div className="rd-root">
        <div className="rd-seg" role="group" aria-label="Which system to simulate">
          <button type="button" aria-pressed={kind === "celeris"} className={kind === "celeris" ? "on" : ""} onClick={() => reset("celeris")}>
            With mutation IDs (CelerisDB)
          </button>
          <button type="button" aria-pressed={kind === "naive"} className={kind === "naive" ? "on" : ""} onClick={() => reset("naive")}>
            Naive system
          </button>
        </div>

        <div className="rd-stage">
          <div className="rd-col">
            <span className="rd-h">Client</span>
            <div className="rd-card">
              <div>Wants to charge $40</div>
              <div className="rd-sub">{kind === "celeris" ? `ID ${MID}` : "no ID"}</div>
              <div className="rd-sub">attempts: {attempts}</div>
            </div>
          </div>

          <div className="rd-net" aria-hidden="true">
            <div className={`rd-pipe ${phase}`}>
              {phase === "inflight" ? <span className="rd-pkt back" /> : null}
              {phase === "timeout" ? <span className="rd-lost">lost</span> : null}
            </div>
          </div>

          <div className="rd-col">
            <span className="rd-h">Server</span>
            <div className={`rd-card ${bad ? "bad" : ""}`}>
              <div>Card charged</div>
              <div className="rd-big">{charges}x</div>
              <div className="rd-sub">{bad ? "$80 taken for one order" : charges === 1 ? "$40 taken" : "nothing yet"}</div>
            </div>
          </div>
        </div>

        <div className="rd-actions">
          {phase === "idle" ? (
            <Button kind="primary" onClick={send}>
              1. Send the charge
            </Button>
          ) : null}
          {phase === "inflight" ? (
            <>
              <Button kind="danger" onClick={drop}>
                2. Drop the response
              </Button>
              <Button onClick={deliver}>Let it through</Button>
            </>
          ) : null}
          {phase === "timeout" ? (
            <>
              <Button kind="primary" onClick={retry}>
                3. Retry
              </Button>
              {kind === "celeris" ? <Button onClick={ask}>Or ask: did it commit?</Button> : null}
            </>
          ) : null}
        </div>

        <ol className="rd-log" aria-live="polite">
          {log.length === 0 ? <li className="rd-empty">Nothing sent yet.</li> : null}
          {log.map((l, i) => (
            <li key={i} className={`${l.who} ${l.tone ?? ""}`}>
              <span className="rd-who">{l.who === "net" ? "network" : l.who}</span>
              {l.text}
            </li>
          ))}
        </ol>

        {verdict ? <p className={`rd-verdict ${bad ? "bad" : "ok"}`}>{verdict}</p> : null}
      </div>
    </Demo>
  );
}
