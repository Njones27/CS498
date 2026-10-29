import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { RequireAdmin } from './auth/RequireAdmin'
import { AppShell } from './components/AppShell'
import { LotMappingPage } from './mapping/LotMappingPage'
import { AdminHomePage } from './pages/AdminHomePage'
import { ClosuresPage } from './pages/ClosuresPage'
import { LotListPage } from './pages/LotListPage'
import { LotMapPage } from './pages/LotMapPage'
import { SignInPage } from './pages/SignInPage'
import { SnapshotPhotoPage } from './pages/SnapshotPhotoPage'
import { SnapshotsPlaceholderPage } from './pages/SnapshotsPlaceholderPage'
import { UploadPage } from './pages/UploadPage'

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
          <Route path="/admin/snapshots" element={<RequireAdmin><SnapshotsPlaceholderPage /></RequireAdmin>} />
          <Route path="/admin/snapshots/:imageId/photo" element={<RequireAdmin><SnapshotPhotoPage /></RequireAdmin>} />
          <Route path="/admin/closures" element={<RequireAdmin><ClosuresPage /></RequireAdmin>} />
          <Route path="/admin/lots/:lotId/map" element={<RequireAdmin><LotMappingPage /></RequireAdmin>} />
          <Route path="*" element={<main className="page"><h1>Page not found</h1></main>} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
