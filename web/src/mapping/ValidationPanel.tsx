import type { DraftLayout, Issue, ValidationReport } from './types'

export interface ValidationPanelProps {
  /** The last validation, or null before the first Validate. */
  report: ValidationReport | null
  draft: DraftLayout
  /** Clicking an issue selects its first space. */
  onSelectSpace: (spaceId: string) => void
}

/** What Validate does, for its tooltip and the empty report. */
export const VALIDATE_HELP =
  'Saves the draft and checks it the way Publish will: errors (duplicate or missing labels, outlines off the photo, ' +
  'found stalls not yet reviewed, spaces off the map) block publishing; warnings (spaces with no outline, ' +
  'overlapping spaces) do not. Publish runs the same check, so this is a dry run.'

/** The report's element id, so the page can scroll it into view after a check. */
export const VALIDATION_ID = 'mapping-validation'

function comparedWith(report: ValidationReport): string {
  return report.comparedWith == null ? 'Nothing published yet' : `Draft compared with v${report.comparedWith}`
}

/** One line on whether the draft can be published. */
function verdict(report: ValidationReport): string {
  const e = report.errors.length
  const w = report.warnings.length
  const warnings = w === 0 ? '' : ` ${w} ${w === 1 ? 'warning' : 'warnings'} (these don't block it).`
  return e === 0
    ? `Ready to publish.${warnings}`
    : `${e} ${e === 1 ? 'problem blocks' : 'problems block'} publishing; fix ${e === 1 ? 'it' : 'them'} first.${warnings}`
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
      <section className="mapping-panel mapping-validation" aria-label="Validation" id={VALIDATION_ID}>
        <h2>Validation</h2>
        <p className="muted">Press Validate to check the draft before publishing. {VALIDATE_HELP}</p>
      </section>
    )
  }
  const labels = new Map(draft.spaces.map((s) => [s.spaceId, s.label.trim() || s.spaceId]))
  const summary = diffSummary(report)
  return (
    <section className="mapping-panel mapping-validation" aria-label="Validation" id={VALIDATION_ID}>
      <h2>
        Validation <span className="mapping-head__part">{comparedWith(report)}</span>
      </h2>
      <p className="hint">{verdict(report)}</p>
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
