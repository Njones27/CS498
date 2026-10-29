import type { DraftLayout, Issue, ValidationReport } from './types'

export interface ValidationPanelProps {
  /** The last validation, or null before the first Validate. */
  report: ValidationReport | null
  draft: DraftLayout
  /** Clicking an issue selects its first space. */
  onSelectSpace: (spaceId: string) => void
}

function comparedWith(report: ValidationReport): string {
  return report.comparedWith == null ? 'Nothing published yet' : `Draft compared with v${report.comparedWith}`
}

function diffSummary(report: ValidationReport): string | null {
  const { added, retired, changed } = report.diff
  const parts = [
    added.length > 0 && `${added.length} added`,
    retired.length > 0 && `${retired.length} retired`,
    changed.length > 0 && `${changed.length} changed`,
  ].filter(Boolean)
  return parts.length > 0 ? `Spaces: ${parts.join(', ')}` : null
}

/** The validation report (Sketch 6): x for errors, which block publishing, ! for warnings. */
export function ValidationPanel({ report, draft, onSelectSpace }: ValidationPanelProps) {
  if (!report) {
    return (
      <section className="mapping-panel mapping-validation" aria-label="Validation">
        <h2>Validation</h2>
        <p className="muted">Press Validate to check the draft before publishing.</p>
      </section>
    )
  }
  const labels = new Map(draft.spaces.map((s) => [s.spaceId, s.label.trim() || s.spaceId]))
  const summary = diffSummary(report)
  return (
    <section className="mapping-panel mapping-validation" aria-label="Validation">
      <h2>
        Validation <span className="mapping-head__part">{comparedWith(report)}</span>
      </h2>
      {summary && <p className="hint">{summary}</p>}
      {report.errors.length === 0 && report.warnings.length === 0 && <p className="validation-ok">No problems found.</p>}
      {(report.errors.length > 0 || report.warnings.length > 0) && (
        <ul className="validation-issues">
          {report.errors.map((issue, i) => (
            <IssueRow key={`e${i}`} issue={issue} kind="error" labels={labels} onSelectSpace={onSelectSpace} />
          ))}
          {report.warnings.map((issue, i) => (
            <IssueRow key={`w${i}`} issue={issue} kind="warning" labels={labels} onSelectSpace={onSelectSpace} />
          ))}
        </ul>
      )}
    </section>
  )
}

interface IssueRowProps {
  issue: Issue
  kind: 'error' | 'warning'
  labels: Map<string, string>
  onSelectSpace: (spaceId: string) => void
}

function IssueRow({ issue, kind, labels, onSelectSpace }: IssueRowProps) {
  // Outlines of unknown spaces list ids that aren't in the draft; those can't be selected.
  const known = issue.spaceIds.filter((id) => labels.has(id))
  const spaces = issue.spaceIds.map((id) => labels.get(id) ?? id).join(', ')
  const body = (
    <>
      <span className="validation-issue__mark" aria-hidden="true">
        {kind === 'error' ? 'x' : '!'}
      </span>
      <span className="validation-issue__text">
        <span className="visually-hidden">{kind === 'error' ? 'Error: ' : 'Warning: '}</span>
        {issue.message}
        {spaces && <span className="validation-issue__spaces"> · {spaces}</span>}
      </span>
      {kind === 'error' && <span className="validation-issue__tag">blocks publish</span>}
    </>
  )
  return (
    <li className={`validation-issue validation-issue--${kind}`}>
      {known.length > 0 ? (
        <button type="button" className="validation-issue__button" onClick={() => onSelectSpace(known[0])}>
          {body}
        </button>
      ) : (
        <div className="validation-issue__button">{body}</div>
      )}
    </li>
  )
}
