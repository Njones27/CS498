/**
 * A compass rose whose needle points north: `northDeg` degrees clockwise from the map's up. The "N" and
 * the label say it in text too, not just by the needle's angle.
 */
export function Compass({
  northDeg,
  size = 44,
  className = '',
}: {
  northDeg: number
  size?: number
  className?: string
}) {
  const deg = ((Math.round(northDeg) % 360) + 360) % 360
  return (
    <svg
      className={`compass ${className}`}
      width={size}
      height={size}
      viewBox="-22 -22 44 44"
      role="img"
      aria-label={`North is ${deg}° clockwise from up`}
      data-testid="compass"
    >
      <title>{`North: ${deg}° clockwise from up`}</title>
      <circle r="20" className="compass__ring" />
      <g transform={`rotate(${deg})`}>
        <path d="M0,-15 L5,2 L0,-2 L-5,2 Z" className="compass__north" />
        <path d="M0,15 L5,2 L0,-2 L-5,2 Z" className="compass__south" />
        <text y="-16" textAnchor="middle" dominantBaseline="auto" fontSize="8" className="compass__n">
          N
        </text>
      </g>
    </svg>
  )
}
