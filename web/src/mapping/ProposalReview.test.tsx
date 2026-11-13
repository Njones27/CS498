import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { rylanDraftFixture } from './fixtures/rylan'
import { ProposalReview } from './ProposalReview'
import type { DraftLayout, DraftViewpoint } from './types'

/** V1 of the fixture lot with `ids` as proposals waiting for review. */
function withPending(ids: string[]): { draft: DraftLayout; view: DraftViewpoint } {
  const draft = structuredClone(rylanDraftFixture)
  const view = draft.viewpoints.find((v) => v.viewId === 'V1')!
  view.outlineReview = Object.fromEntries(
    Object.keys(view.outlines).map((id) => [id, { source: 'proposed' as const, status: ids.includes(id) ? ('pending' as const) : ('accepted' as const), evidence: 0.5 }]),
  )
  return { draft, view }
}

function panel(ids: string[], onReject = vi.fn()) {
  const { draft, view } = withPending(ids)
  return (
    <ProposalReview draft={draft} view={view} selectedSpaceId={null} onSelectSpace={vi.fn()} onHoverSpace={vi.fn()} onAccept={vi.fn()} onReject={onReject} />
  )
}

describe('Reject all asks in the page', () => {
  it('names the question for the confirm button, and Cancel or Escape hands focus back', async () => {
    const user = userEvent.setup()
    const onReject = vi.fn()
    render(panel(['sp_a01', 'sp_a02'], onReject))
    await user.click(screen.getByTestId('reject-all-proposals-btn'))
    const confirm = screen.getByTestId('confirm-reject-all-btn')
    expect(confirm).toHaveFocus()
    expect(confirm).toHaveAccessibleDescription('Reject all 2 in V1?')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('confirm-reject-all-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('reject-all-proposals-btn')).toHaveFocus()

    await user.click(screen.getByTestId('reject-all-proposals-btn'))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('confirm-reject-all-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('reject-all-proposals-btn')).toHaveFocus()
    expect(onReject).not.toHaveBeenCalled()
  })

  it('closes the question when the proposals it asked about change', async () => {
    const user = userEvent.setup()
    const { rerender } = render(panel(['sp_a01', 'sp_a02']))
    await user.click(screen.getByTestId('reject-all-proposals-btn'))
    expect(screen.getByTestId('confirm-reject-all-btn')).toBeInTheDocument()
    // The admin moves on to a row and one proposal is accepted: "Reject all 2" no longer says what
    // would happen. Closing by itself, it does not pull focus back to the Reject all button.
    const row = screen.getAllByRole('button', { name: /^Accept proposal for/ })[0]
    row.focus()
    rerender(panel(['sp_a01']))
    expect(screen.queryByTestId('confirm-reject-all-btn')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Accept proposal for/ })[0]).toHaveFocus()
    // Asked again, then one proposal swapped for another (the same number waiting): closed too.
    await user.click(screen.getByTestId('reject-all-proposals-btn'))
    rerender(panel(['sp_a02']))
    expect(screen.queryByTestId('confirm-reject-all-btn')).not.toBeInTheDocument()
    // None left, then new ones found: the old question does not come back by itself.
    rerender(panel([]))
    rerender(panel(['sp_a01', 'sp_a02']))
    expect(screen.queryByTestId('confirm-reject-all-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('reject-all-proposals-btn')).toBeInTheDocument()
  })
})
