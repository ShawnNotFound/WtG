import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GameEnd } from '../components/GameEnd';
import { Button, Card } from '../components/ui';
import { FinalSummary, Headline, Player } from '../hooks/useSocket';

const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

interface AdminSummaryResponse {
  session: {
    id: string;
    title: string;
    joinCode: string;
    phase: string;
    currentRound: number;
    maxRounds: number;
    playMinutes: number;
    createdAt: string;
  };
  players: Player[];
  headlines: Headline[];
  finalSummary: FinalSummary;
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error ?? 'Admin request failed');
  }
  return data;
}

export function AdminSummaryPage() {
  const { joinCode = '' } = useParams();
  const navigate = useNavigate();
  const [passwordInput, setPasswordInput] = useState('');
  const [password, setPassword] = useState(() => localStorage.getItem('futureHeadlines_adminPassword') ?? '');
  const [data, setData] = useState<AdminSummaryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!password || !joinCode) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/admin/sessions/${joinCode.toUpperCase()}/summary`, {
        headers: {
          'x-admin-password': password,
        },
      });
      const summaryData = await readJson(response);
      setData(summaryData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load summary page');
    } finally {
      setLoading(false);
    }
  }, [joinCode, password]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const submitLogin = (event: FormEvent) => {
    event.preventDefault();
    const nextPassword = passwordInput.trim();
    localStorage.setItem('futureHeadlines_adminPassword', nextPassword);
    setPassword(nextPassword);
    setPasswordInput('');
    setError('');
  };

  const totalGameMins = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, data.session.playMinutes * data.session.maxRounds);
  }, [data]);

  if (!password) {
    return (
      <div className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-6">
        <Card padding="lg" className="w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Admin Summary</h1>
            <p className="text-sm text-gray-500">Enter the admin password to view session {joinCode.toUpperCase()}.</p>
          </div>
          <form onSubmit={submitLogin} className="space-y-3">
            <input
              type="password"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              placeholder="Password"
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <Button fullWidth type="submit">Login</Button>
          </form>
          <Button fullWidth variant="ghost" onClick={() => navigate('/admin')}>
            Back to Admin
          </Button>
        </Card>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-6">
        <div className="text-center">
          <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-gray-200 border-t-indigo-500" />
          <p className="text-sm text-gray-400">Loading summary page...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-6">
        <Card padding="lg" className="w-full max-w-md space-y-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Summary Unavailable</h1>
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={loadSummary} disabled={loading}>
              Retry
            </Button>
            <Button variant="secondary" onClick={() => navigate('/admin')}>
              Back to Admin
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gradient-to-b from-gray-50 to-gray-100/80">
      <GameEnd
        title={data.session.title}
        joinCode={data.session.joinCode}
        players={data.players}
        headlines={data.headlines}
        currentPlayerId=""
        maxRounds={data.session.maxRounds}
        totalGameMins={totalGameMins}
        currentGameMins={totalGameMins}
        finalSummary={data.finalSummary}
        onBack={() => navigate('/admin')}
        backLabel="Back to Admin"
      />
    </div>
  );
}
