import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { getToken } from "@/lib/api";
import Login from "@/pages/Login";
import LeagueList from "@/pages/LeagueList";
import LeagueRoom from "@/pages/LeagueRoom";

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <LeagueList />
            </RequireAuth>
          }
        />
        <Route
          path="/league/:id"
          element={
            <RequireAuth>
              <LeagueRoom />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
