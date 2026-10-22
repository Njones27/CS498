import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { RequireAdmin } from './auth/RequireAdmin'
import { AppShell } from './components/AppShell'
import { AdminHomePage } from './pages/AdminHomePage'
import { LotListPage } from './pages/LotListPage'
import { LotMapPage } from './pages/LotMapPage'
import { SignInPage } from './pages/SignInPage'
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
