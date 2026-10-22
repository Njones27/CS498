import type { StateIcon as Icon } from '../lib/status'

/** 24x24 glyphs drawn inside a space; shapes differ per state so color is not required (NFR-8). */
export function StateGlyph({ icon }: { icon: Icon }) {
  switch (icon) {
    case 'car':
      return (
        <g className="glyph glyph--car" data-icon="car">
          <path d="M5 11l2-5h10l2 5" fill="none" strokeWidth="1.8" />
          <rect x="3" y="11" width="18" height="6" rx="1.5" />
          <circle cx="7.5" cy="18" r="2" />
          <circle cx="16.5" cy="18" r="2" />
        </g>
      )
    case 'barrier':
      return (
        <g className="glyph glyph--barrier" data-icon="barrier">
          <rect x="2" y="8" width="20" height="6" rx="1" />
          <path d="M6 8l-4 6M12 8l-4 6M18 8l-4 6M22 9l-3 5" strokeWidth="1.6" className="glyph__stripes" />
          <path d="M5 14v6M19 14v6" strokeWidth="2" />
        </g>
      )
    case 'unknown':
      return (
        <g className="glyph glyph--unknown" data-icon="unknown">
          <text x="12" y="17" textAnchor="middle" fontSize="16" fontWeight="700">
            ?
          </text>
        </g>
      )
    case 'empty':
    default:
      return <g className="glyph glyph--empty" data-icon="empty" />
  }
}

/** Small standalone icon for legends and summary bars. */
export function StateIconSvg({ icon, className }: { icon: Icon; className: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className={`legend-swatch ${className}`}>
      <rect x="1" y="1" width="22" height="22" rx="3" className="space__rect" />
      <StateGlyph icon={icon} />
    </svg>
  )
}
