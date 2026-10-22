import { Link } from 'react-router-dom'

const COMING_SOON = ['Snapshots', 'Map']

export function AdminHomePage() {
  return (
    <main className="page page--narrow">
      <h1>Admin</h1>
      <ul className="admin-links">
        <li>
          <Link to="/admin/upload" className="admin-link">
            Upload
          </Link>
        </li>
        <li>
          <Link to="/admin/closures" className="admin-link">
            Closures
          </Link>
        </li>
        {COMING_SOON.map((name) => (
          <li key={name}>
            <span className="admin-link admin-link--disabled" aria-disabled="true">
              {name} <span className="muted">(coming soon)</span>
            </span>
          </li>
        ))}
      </ul>
    </main>
  )
}
