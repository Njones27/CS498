import { lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { RequireAdmin } from './auth/RequireAdmin'
import { AppShell } from './components/AppShell'
import { AdminHomePage } from './pages/AdminHomePage'
import { LotListPage } from './pages/LotListPage'
import { LotMapPage } from './pages/LotMapPage'
import { SignInPage } from './pages/SignInPage'

const LotMappingPage = lazy(() => import('./mapping/LotMappingPage').then((m) => ({ default: m.LotMappingPage })))
const VersionsPage = lazy(() => import('./mapping/VersionsPage').then((m) => ({ default: m.VersionsPage })))
const NewLotPage = lazy(() => import('./pages/NewLotPage').then((m) => ({ default: m.NewLotPage })))
const OverridesPage = lazy(() => import('./pages/OverridesPage').then((m) => ({ default: m.OverridesPage })))
const SnapshotPhotoPage = lazy(() =>
  import('./pages/SnapshotPhotoPage').then((m) => ({ default: m.SnapshotPhotoPage })),
)
const SnapshotsPage = lazy(() => import('./pages/SnapshotsPage').then((m) => ({ default: m.SnapshotsPage })))
const UploadPage = lazy(() => import('./pages/UploadPage').then((m) => ({ default: m.UploadPage })))

/** Route table; split out so tests can mount it inside a MemoryRouter. */
export function AppRoutes() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<LotListPage />} />
          <Route path="/lots/:lotId" element={<LotMapPage />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/admin" element={<RequireAdmin><AdminHomePage /></RequireAdmin>} />
          <Route path="/admin/upload" element={<RequireAdmin><UploadPage /></RequireAdmin>} />
          <Route path="/admin/snapshots" element={<RequireAdmin><SnapshotsPage /></RequireAdmin>} />
          <Route path="/admin/snapshots/:imageId/photo" element={<RequireAdmin><SnapshotPhotoPage /></RequireAdmin>} />
          {/* Closures moved into Set space state; keep old links and bookmarks working. */}
          <Route path="/admin/closures" element={<Navigate to="/admin/overrides" replace />} />
          <Route path="/admin/overrides" element={<RequireAdmin><OverridesPage /></RequireAdmin>} />
          <Route path="/admin/lots/new" element={<RequireAdmin><NewLotPage /></RequireAdmin>} />
          <Route path="/admin/lots/:lotId/map" element={<RequireAdmin><LotMappingPage /></RequireAdmin>} />
          <Route path="/admin/lots/:lotId/versions" element={<RequireAdmin><VersionsPage /></RequireAdmin>} />
          <Route path="*" element={<main className="page"><h1>Page not found</h1></main>} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AppRoutes />
    </BrowserRouter>
  )
}
