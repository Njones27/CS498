import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAdminLot } from '../admin/AdminLotContext'
import { api, errorMessage } from '../api/client'
import type { AdminLotCreate, AdminLotOut } from '../api/lotsAdmin'

export const NAME_REQUIRED = 'Enter a name for the lot'
export const AGE_RANGE = 'Allowed data age must be a whole number of minutes from 1 to 1440'

/** US-16 #1, #2: create an unpublished lot with an empty draft, then open its mapping page. */
export function NewLotPage() {
  const { lotCreated } = useAdminLot()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [minutes, setMinutes] = useState('30')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const age = Number(minutes)
    if (!name.trim()) return setError(NAME_REQUIRED)
    if (!/^\d+$/.test(minutes.trim()) || age < 1 || age > 1440) return setError(AGE_RANGE)
    setError(null)
    setBusy(true)
    try {
      const body: AdminLotCreate = { name: name.trim(), location: location.trim(), staleAfterMinutes: age }
      const lot = await api.post<AdminLotOut>('/admin/lots', body)
      lotCreated(lot)
      navigate(`/admin/lots/${encodeURIComponent(lot.lotId)}/map`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <main className="page page--narrow">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <h1>New lot</h1>
      <p className="hint">
        The lot starts with an empty draft layout. Drivers see it only after you map and publish it.
      </p>
      <form className="form" onSubmit={onSubmit} noValidate>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
        </label>
        <label>
          Location
          <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
        </label>
        <label>
          Allowed data age (minutes)
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-describedby="lot-age-hint"
            required
          />
        </label>
        <p id="lot-age-hint" className="hint">
          Drivers see a stale-data warning when observations are older than this.
        </p>
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create lot'}
          </button>
        </div>
      </form>
    </main>
  )
}
