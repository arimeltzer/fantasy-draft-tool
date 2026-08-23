import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "@/lib/api";

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { access_token } = await api.login(email, password);
      setToken(access_token);
      nav("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-pop">
        <div className="mb-7 text-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-gold grid place-items-center mx-auto mb-4 shadow-[0_4px_10px_rgba(180,83,9,0.25)]">
            <span className="text-2xl">🏈</span>
          </div>
          <h1 className="text-xl font-extrabold tracking-tight text-ink">Fantasy Draft Assistant</h1>
          <p className="text-sm text-muted mt-1">Sign in to your account</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-3.5 py-2.5 rounded-xl bg-sunken border border-line text-sm text-ink focus:outline-none focus:border-gold/60"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3.5 py-2.5 rounded-xl bg-sunken border border-line text-sm text-ink focus:outline-none focus:border-gold/60"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-gradient-to-br from-amber-400 to-gold text-white text-sm font-bold shadow-[0_4px_10px_rgba(180,83,9,0.25)] hover:opacity-95 disabled:opacity-50 transition-opacity"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
