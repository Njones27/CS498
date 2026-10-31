import { useState } from 'react'
import { evidenceWord, pendingProposals } from './proposals'
import type { DraftLayout, DraftViewpoint } from './types'

/** How many proposals the list shows before "Show all". */
const SHOWN = 8

interface Props {
  draft: DraftLayout
  view: DraftViewpoint
  selectedSpaceId: string | null
  onSelectSpace: (spaceId: string | null) => void
  onHoverSpace: (spaceId: string | null) => void
  onAccept: (spaceIds: string[]) => void
  onReject: (spaceIds: string[]) => void
}

/**
 * Proposed outlines on this photo still waiting for review (HDD §6.5), weakest evidence first, so the
 * admin checks the doubtful ones and accepts the rest in one go. Pending proposals block publishing.
 */
export function ProposalReview({ draft, view, selectedSpaceId, onSelectSpace, onHoverSpace, onAccept, onReject }: Props) {
  const [showAll, setShowAll] = useState(false)
  const pending = pendingProposals(view)
  if (pending.length === 0) return null
  const label = (id: string) => draft.spaces.find((s) => s.spaceId === id)?.label ?? id
  const shown = showAll ? pending : pending.slice(0, SHOWN)
  const all = pending.map((p) => p.spaceId)

  return (
    <section className="ref-proposals" aria-label="Proposed outlines" data-testid="proposal-review">
      <div className="ref-proposals__head">
        <h2>
          {pending.length} proposed {pending.length === 1 ? 'outline' : 'outlines'}
        </h2>
        <span className="hint">Weakest first. Check these on the photo, then accept the rest.</span>
        <div className="ref-proposals__bulk">
          <button
            type="button"
            className="button button--primary button--sm"
            onClick={() => onAccept(all)}
            data-testid="accept-all-proposals-btn"
          >
            Accept all
          </button>
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => {
              if (window.confirm(`Reject all ${pending.length} proposed outlines in ${view.viewId}?`)) onReject(all)
            }}
            data-testid="reject-all-proposals-btn"
          >
            Reject all
          </button>
        </div>
      </div>
      <ul className="ref-proposals__list">
        {shown.map(({ spaceId, evidence, partial }) => (
          <li
            key={spaceId}
            className={`ref-proposals__item${selectedSpaceId === spaceId ? ' is-selected' : ''}`}
            data-testid={`proposal-banner-${spaceId}`}
            onPointerEnter={() => onHoverSpace(spaceId)}
            onPointerLeave={() => onHoverSpace(null)}
          >
            <button type="button" className="ref-proposals__name" onClick={() => onSelectSpace(spaceId)}>
              <strong>{label(spaceId)}</strong>
            </button>
            <span className="ref-proposals__evidence" title={evidence === null ? undefined : `Evidence ${Math.round(evidence * 100)}%`}>
              {evidenceWord(evidence)}
              {partial && <span className="muted"> · Partly outside the photo</span>}
              {evidence !== null && <span className="muted"> {Math.round(evidence * 100)}%</span>}
            </span>
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => onAccept([spaceId])}
              aria-label={`Accept proposal for ${label(spaceId)}`}
            >
              Accept
            </button>
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => onReject([spaceId])}
              aria-label={`Reject proposal for ${label(spaceId)}`}
            >
              Reject
            </button>
          </li>
        ))}
      </ul>
      {pending.length > SHOWN && (
        <button type="button" className="button button--ghost button--sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${pending.length}`}
        </button>
      )}
    </section>
  )
}
