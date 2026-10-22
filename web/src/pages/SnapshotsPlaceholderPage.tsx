import { Link, useLocation } from 'react-router-dom'

/**
 * Stand-in for the admin Snapshots page (built separately) so links such as the upload page's
 * "View the original" (`/admin/snapshots#<imageId>`) resolve instead of 404ing.
 */
export function SnapshotsPlaceholderPage() {
  const { hash } = useLocation()
  const imageId = decodeHash(hash)
  return (
    <main className="page page--narrow">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <h1>Snapshots</h1>
      <p>The Snapshots page is coming soon.</p>
      {imageId && (
        <p>
          Snapshot: <code>{imageId}</code>
        </p>
      )}
    </main>
  )
}

function decodeHash(hash: string): string {
  const raw = hash.replace(/^#/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
