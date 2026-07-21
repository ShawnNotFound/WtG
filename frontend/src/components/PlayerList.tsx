import { Card, SectionTitle, Badge } from './ui';

interface Player {
  id: string;
  nickname: string;
  isHost: boolean;
  isAi?: boolean;
  joinedAt: string;
  totalScore?: number;
}

interface PlayerListProps {
  players: Player[];
  currentPlayerId?: string;
  compact?: boolean;
}

export function PlayerList({ players, currentPlayerId, compact = false }: PlayerListProps) {
  return (
    <Card padding={compact ? 'sm' : 'md'}>
      <SectionTitle count={players.length}>Players</SectionTitle>

      {players.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-3">No players yet</p>
      ) : (
        <ul className={`space-y-1 overflow-y-auto pr-0.5 ${compact ? 'max-h-[30dvh]' : 'max-h-[40dvh]'}`}>
          {players.map((player) => {
            const isYou = player.id === currentPlayerId;
            return (
              <li
                key={player.id}
                className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-sm ${
                  isYou ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      player.isHost ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                  />
                  <span className={`truncate ${isYou ? 'font-semibold text-indigo-700' : 'text-gray-700'}`}>
                    {player.nickname}
                    {isYou && <span className="text-gray-400 font-normal ml-1">(You)</span>}
                  </span>
                  {player.isHost && <Badge variant="yellow">Host</Badge>}
                  {player.isAi && <Badge variant="purple">AI</Badge>}
                </div>
                <span className="text-xs font-medium text-gray-500 tabular-nums shrink-0 ml-2">
                  {player.totalScore ?? 0} pts
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
