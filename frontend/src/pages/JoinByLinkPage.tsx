import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Button } from '../components/ui';

interface JoinByLinkPageProps {
  connected: boolean;
  loading: boolean;
  error: string;
  onJoinSession: (joinCode: string, nickname: string) => Promise<void>;
}

export function JoinByLinkPage({ connected, loading, error, onJoinSession }: JoinByLinkPageProps) {
  const { joinCode } = useParams<{ joinCode: string }>();
  const [nickname, setNickname] = useState('');
  const [localError, setLocalError] = useState('');

  const handleJoin = async () => {
    const trimmedNickname = nickname.trim();
    if (!trimmedNickname) {
      setLocalError('Please enter a nickname');
      return;
    }
    if (trimmedNickname.length < 3) {
      setLocalError('Nickname must be at least 3 characters');
      return;
    }
    if (!joinCode) {
      setLocalError('Invalid join link');
      return;
    }
    setLocalError('');
    await onJoinSession(joinCode, trimmedNickname);
  };

  const displayError = localError || error;

  return (
    <div className="h-[100dvh] overflow-hidden bg-gradient-to-b from-gray-50 to-gray-100/80 flex items-center justify-center p-4">
      <div className="max-w-sm w-full space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-4xl font-bold text-gray-900">Future Headlines</h1>
          <p className="text-sm text-gray-500">You've been invited to join a game</p>
        </div>

        <div className="flex items-center justify-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>

        <Card padding="lg" className="space-y-5">
          <div className="text-center">
            <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Game Code</p>
            <span className="text-2xl font-mono font-bold text-indigo-600 tracking-widest">
              {joinCode?.toUpperCase()}
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Nickname
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Enter your nickname"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-gray-50"
              minLength={3}
              maxLength={20}
              onKeyDown={(e) => e.key === 'Enter' && !loading && handleJoin()}
            />
          </div>

          {displayError && (
            <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
              {displayError}
            </div>
          )}

          <Button
            fullWidth
            size="lg"
            onClick={handleJoin}
            disabled={loading || !connected}
          >
            {loading ? 'Joining...' : 'Join Game'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
