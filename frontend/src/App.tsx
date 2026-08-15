import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { getToken } from "@/lib/api";
import YahooCallback from "@/components/YahooCallback";
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
      {/* Yahoo's redirect lands on a normal app screen with ?code= — finish
          the handshake there instead of making the user copy it out. */}
      <YahooCallback />
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
