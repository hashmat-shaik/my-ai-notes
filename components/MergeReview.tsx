import { useState } from "react"

import { blockFor, type Heading, type MergeItem, type PinMeta } from "../lib/merge"
import { Icon } from "./Icon"

type Tab = "new" | "refine" | "skipped"

type Props = {
  items: MergeItem[]
  accepted: Record<string, boolean>
  headings: Heading[]
  pinMeta: Map<number, PinMeta>
  onSet: (id: string, value: boolean) => void
  onMove: (id: string, target: string) => void // heading index as a string, or "new"
  onJump: (headingIdx: number) => void
  onRejectAll: () => void
  onApprove: () => void
  onDiscard: () => void
}

export function MergeReview(props: Props) {
  const { items, accepted, headings, pinMeta } = props

  const news = items.filter((i) => i.action === "NEW")
  const refines = items.filter((i) => i.action === "REFINE")
  const skipped = items.filter((i) => i.action === "SKIP")
  const approved = items.filter((i) => i.action !== "SKIP" && accepted[i.id]).length

  const [tab, setTab] = useState<Tab>(news.length ? "new" : refines.length ? "refine" : "skipped")
  const list = tab === "new" ? news : tab === "refine" ? refines : skipped

  const card = (it: MergeItem) => {
    const on = !!accepted[it.id]
    const inserts = it.action === "NEW" || it.status === "old-not-found"
    return (
      <div key={it.id} className={`mi ${on ? "on" : "off"}`}>
        <div className="mi-head">
          <span className={`mi-badge ${it.action === "NEW" ? "new" : "refine"}`}>{it.action === "NEW" ? "NEW" : "REFINE"}</span>

          {inserts ? (
            <label className="mi-dest">
              <span className="muted">to</span>
              <select
                value={it.targetIdx != null ? String(it.targetIdx) : "new"}
                onChange={(e) => props.onMove(it.id, e.target.value)}
                aria-label="Destination section">
                {headings.map((h) => (
                  <option key={h.idx} value={String(h.idx)}>
                    {"· ".repeat(h.level - 1)}
                    {h.text}
                  </option>
                ))}
                <option value="new">+ New section{it.newSection ? `: ${it.newSection.title}` : ""}</option>
              </select>
            </label>
          ) : (
            <span className="mi-dest">
              <span className="muted">in</span>
              {it.foundIn && it.foundIdx != null ? (
                <button className="link" onClick={() => props.onJump(it.foundIdx!)}>
                  {it.foundIn}
                </button>
              ) : (
                <span>the note</span>
              )}
            </span>
          )}

          <span className="spacer" />
          <button
            className={`mi-btn ok ${on ? "active" : ""}`}
            aria-label="Accept"
            aria-pressed={on}
            title="Accept"
            onClick={() => props.onSet(it.id, true)}>
            <Icon name="check" size={14} />
          </button>
          <button
            className={`mi-btn no ${!on ? "active" : ""}`}
            aria-label="Reject"
            aria-pressed={!on}
            title="Reject"
            onClick={() => props.onSet(it.id, false)}>
            <Icon name="x" size={14} />
          </button>
        </div>

        {it.status === "old-not-found" && (
          <div className="mi-warn">Couldn't find the original passage in your note, so this would be added as new text instead.</div>
        )}
        {it.similar && (
          <div className="mi-warn">Looks similar to text already in your note: “{it.similar.snippet}”. Left unchecked, so review it.</div>
        )}

        {it.action === "REFINE" && it.status === "ok" && it.old && <pre className="diff old">{it.old}</pre>}
        <pre className="diff new">{inserts ? blockFor(it, pinMeta) : it.text}</pre>
        {it.why && <div className="mi-why">{it.why}</div>}
      </div>
    )
  }

  return (
    <div className="merge-review">
      <div className="side-head">
        <Icon name="sparkle" size={15} />
        <strong>AI Merge Results</strong>
        <span className="spacer" />
        <span className="chip-sum">
          {news.length} new · {refines.length} refine · {skipped.length} skipped
        </span>
      </div>

      <div className="mr-tabs">
        <div className="seg" role="tablist" aria-label="Result type">
          <button role="tab" aria-selected={tab === "new"} className={tab === "new" ? "active" : ""} onClick={() => setTab("new")}>
            New ({news.length})
          </button>
          <button role="tab" aria-selected={tab === "refine"} className={tab === "refine" ? "active" : ""} onClick={() => setTab("refine")}>
            Refine ({refines.length})
          </button>
          <button role="tab" aria-selected={tab === "skipped"} className={tab === "skipped" ? "active" : ""} onClick={() => setTab("skipped")}>
            Skipped ({skipped.length})
          </button>
        </div>
      </div>

      <div className="side-scroll">
        {list.length === 0 && (
          <p className="muted pad">
            {tab === "skipped" ? "Nothing was skipped as a duplicate." : tab === "new" ? "No new items." : "No refinements."}
          </p>
        )}

        {tab !== "skipped" && list.map(card)}

        {tab === "skipped" &&
          skipped.map((it) => (
            <div key={it.id} className="mi skip">
              <div className="mi-head">
                <span className="mi-badge skip">SKIPPED</span>
                <span className="muted small">pin {it.pins.join(", ") || "?"}</span>
              </div>
              <div className="mi-why strong">{it.why || "Already covered in your note."}</div>
              {it.foundIn && it.foundIdx != null && (
                <button className="link small" onClick={() => props.onJump(it.foundIdx!)}>
                  Found in: {it.foundIn}
                </button>
              )}
            </div>
          ))}
      </div>

      <div className="mr-foot">
        <button className="btn" onClick={props.onRejectAll}>
          Reject all
        </button>
        <button className="btn primary grow" disabled={approved === 0} onClick={props.onApprove}>
          Approve ({approved})
        </button>
        <button className="icon-btn" title="Discard these results" aria-label="Discard results" onClick={props.onDiscard}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  )
}