import { useEffect, useId, useRef, useState } from 'react'
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
  // The set of proposals "Reject all" was asked about: the question closes by itself when the view or
  // the proposals waiting change, so it never opens on a list the admin has not been asked about.
  const asking = `${view.viewId}:${pending.map((p) => p.spaceId).join(',')}`
  const [askedFor, setAskedFor] = useState<string | null>(null)
  if (askedFor !== null && askedFor !== asking) setAskedFor(null) // asked about another set: forget it
  const confirmingReject = askedFor === asking && pending.length > 0
  const questionId = useId()
  const rejectAllRef = useRef<HTMLButtonElement>(null)
  // Cancelled (or closed with Escape): focus goes back to the button that asked. Not when the question
  // closes by itself, which would pull focus from whatever the admin was doing.
  const backToButton = useRef(false)
  useEffect(() => {
    if (confirmingReject || !backToButton.current) return
    backToButton.current = false
    rejectAllRef.current?.focus()
  }, [confirmingReject])
  const cancel = () => {
    backToButton.current = true
    setAskedFor(null)
  }
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
        {confirmingReject ? (
          // Asked in the page, not with window.confirm: embedded browsers cancel that without showing it.
          <div
            className="ref-proposals__bulk"
            role="group"
            aria-labelledby={questionId}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // Escape answers the question only: the photo panel's own Escape (deselect, drop a
              // half-drawn outline) must not run as well.
              e.stopPropagation()
              cancel()
            }}
          >
            <span id={questionId}>
              Reject all {pending.length} in {view.viewId}?
            </span>
            <button
              type="button"
              className="button button--primary button--sm"
              autoFocus
              aria-describedby={questionId}
              onClick={() => {
                setAskedFor(null)
                onReject(all)
              }}
              data-testid="confirm-reject-all-btn"
            >
              Reject {pending.length}
            </button>
            <button type="button" className="button button--ghost button--sm" onClick={cancel}>
              Cancel
            </button>
          </div>
        ) : (
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
              ref={rejectAllRef}
              className="button button--ghost button--sm"
              onClick={() => setAskedFor(asking)}
              data-testid="reject-all-proposals-btn"
            >
              Reject all
            </button>
          </div>
        )}
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
