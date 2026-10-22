import type { LayoutOut, SpaceStatusOut } from '../api/schemas'
import { visualFor } from '../lib/status'
import { StateGlyph } from './StateIcon'

interface Props {
  layout: LayoutOut
  statusById: Map<string, SpaceStatusOut>
  selectedId: string | null
  onSelect: (spaceId: string | null) => void
  describe: (spaceId: string) => string
  /** Extra highlighted spaces (multi-select, e.g. the closures page). */
  selectedIds?: ReadonlySet<string>
  /** Toggle mode: click, Enter and Space call this; hover and focus no longer call onSelect. */
  onToggle?: (spaceId: string) => void
}

/** Schematic lot map: one <rect> per space at `layout.spaces[].rect`. */
export function LotMapSvg({ layout, statusById, selectedId, onSelect, describe, selectedIds, onToggle }: Props) {
  const { width, height } = layout.schematic
  return (
    <svg
      className="lot-map"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label="Lot map"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" className="hatch__bg" />
          <line x1="0" y1="0" x2="0" y2="8" className="hatch__line" strokeWidth="3" />
        </pattern>
      </defs>
      {layout.spaces.map((space) => {
        const status = statusById.get(space.spaceId)
        const state = status?.state ?? 'UNKNOWN'
        const v = visualFor(state)
        const stale = status?.stale ?? false
        const { x, y, w, h } = space.rect
        const icon = Math.min(w, h) * 0.6
        const text = describe(space.spaceId)
        const selected = selectedId === space.spaceId || (selectedIds?.has(space.spaceId) ?? false)
        return (
          <g
            key={space.spaceId}
            className={`space ${v.className}${stale ? ' space--stale' : ''}${selected ? ' space--selected' : ''}`}
            data-testid={`space-${space.spaceId}`}
            data-state={state}
            data-stale={stale ? 'true' : 'false'}
            tabIndex={0}
            role="button"
            aria-label={text}
            aria-pressed={onToggle ? selected : undefined}
            onMouseEnter={onToggle ? undefined : () => onSelect(space.spaceId)}
            onFocus={onToggle ? undefined : () => onSelect(space.spaceId)}
            onClick={() => (onToggle ? onToggle(space.spaceId) : onSelect(space.spaceId))}
            onKeyDown={(e) => {
              if (onToggle && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                onToggle(space.spaceId)
              } else if (e.key === 'Escape') onSelect(null)
            }}
          >
            <title>{text}</title>
            <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) * 0.08} className="space__rect" />
            <svg x={x + (w - icon) / 2} y={y + (h - icon) / 2 - h * 0.08} width={icon} height={icon} viewBox="0 0 24 24">
              <StateGlyph icon={v.icon} />
            </svg>
            <text
              x={x + w / 2}
              y={y + h - Math.max(3, h * 0.06)}
              textAnchor="middle"
              className="space__label"
              fontSize={Math.max(8, Math.min(w, h) * 0.2)}
            >
              {space.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
