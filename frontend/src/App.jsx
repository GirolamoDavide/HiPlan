import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ThemeProvider } from './context/ThemeContext';
import MainLayout from './components/layout/MainLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import CalendarPage from './pages/CalendarPage';
import PersonalCalendarPage from './pages/PersonalCalendarPage';
import NotesPage from './pages/NotesPage';
import AdminPage from './pages/AdminPage';
import ConflictMonitoringPage from './pages/ConflictMonitoringPage';
import ReplanningAgentPage from './pages/ReplanningAgentPage';
import ProfilePage from './pages/ProfilePage';
import TicketsPage from './pages/TicketsPage';
import TodoPage from './pages/TodoPage';
import ChatPage from './pages/ChatPage';
import RichiesteCommercialiPage from './pages/RichiesteCommercialiPage';
import AutomationsPage from './pages/AutomationsPage';
import './index.css';
import './workspace-restyle.css';

function ProtectedRoute({ children, adminOnly = false, editorOrAdminOnly = false }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p style={{ color: 'var(--text-secondary)' }}>Caricamento...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  if (editorOrAdminOnly && user.role !== 'admin' && user.role !== 'editor') return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/me" element={<ProfilePage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/personal-calendar" element={<PersonalCalendarPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/todo" element={<TodoPage />} />
        <Route path="/tickets" element={<TicketsPage />} />
        <Route path="/conflicts" element={<ConflictMonitoringPage />} />
        <Route path="/admin/conflicts" element={<ConflictMonitoringPage />} />
        <Route
          path="/replanning"
          element={
            <ProtectedRoute editorOrAdminOnly>
              <ReplanningAgentPage />
            </ProtectedRoute>
          }
        />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/richieste-commerciali" element={<RichiesteCommercialiPage />} />
        <Route
          path="/admin/automations"
          element={
            <ProtectedRoute adminOnly>
              <AutomationsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/automations"
          element={
            <ProtectedRoute adminOnly>
              <Navigate to="/admin/automations" replace />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute adminOnly>
              <AdminPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
