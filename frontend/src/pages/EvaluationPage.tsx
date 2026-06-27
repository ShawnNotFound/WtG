import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, DropdownSelect } from '../components/ui';
import {
  AiProvider,
  baseUrlForProvider,
  defaultModelForProvider,
  modelOptionsForValue,
} from '../lib/modelOptions';

const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const PROVIDER_OPTIONS = [
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'OpenAI', value: 'openai' },
];

interface EvaluationBatchListItem {
  id: string;
  name: string;
  status: string;
  runCount: number;
  judgedRuns: number;
  readyRuns: number;
  averageScore: number | null;
  createdAt: string;
}

interface EvaluationRun {
  id: string;
  runIndex: number;
  joinCode: string | null;
  status: string;
  phase: string | null;
  currentRound: number | null;
  maxRounds: number | null;
  headlineCount: number;
  playerHeadlineCount: number;
  players: Array<{ nickname: string; isAi: boolean; totalScore: number }>;
  overallScore: number | null;
  confidence: string | null;
  error: string | null;
}

interface EvaluationDetail {
  batch: {
    id: string;
    name: string;
    status: string;
    runCount: number;
    concurrency: number;
    createdAt: string;
    completedAt: string | null;
  };
  runs: EvaluationRun[];
  aggregate: {
    totalRuns: number;
    judgedRuns: number;
    readyRuns: number;
    runningRuns: number;
    score: {
      mean: number | null;
      median: number | null;
      stddev: number | null;
      min: number | null;
      max: number | null;
    };
    dimensionMeans: Record<string, number | null>;
    confidenceCounts: Record<string, number>;
    headlineCounts: {
      meanAll: number | null;
      meanPlayer: number | null;
    };
    aiScoreAverages: Array<{
      nickname: string;
      runCount: number;
      meanTotalScore: number | null;
      maxTotalScore: number | null;
    }>;
    topWeaknesses: Array<{ text: string; count: number }>;
    topRecommendations: Array<{ text: string; count: number }>;
    topStrengths: Array<{ text: string; count: number }>;
  };
}

interface AiDraft {
  nickname: string;
  stylePrompt: string;
  creativity: string;
  submitEverySeconds: string;
  provider: AiProvider;
  model: string;
}

const DEFAULT_STYLE = 'Strategic, grounded, specific, and slightly provocative.';

function readJson(response: Response) {
  return response.json().then((data) => {
    if (!response.ok) {
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data;
  });
}

function makeAiDraft(index: number): AiDraft {
  const provider: AiProvider = 'deepseek';
  return {
    nickname: `AI Player ${index + 1}`,
    stylePrompt: DEFAULT_STYLE,
    creativity: '1',
    submitEverySeconds: '0',
    provider,
    model: defaultModelForProvider(provider),
  };
}

function statusVariant(status: string): 'default' | 'green' | 'blue' | 'purple' | 'yellow' | 'red' {
  if (status === 'judged' || status === 'completed') return 'green';
  if (status === 'ready_for_judge') return 'purple';
  if (status === 'running' || status === 'starting') return 'blue';
  if (status === 'pending') return 'yellow';
  if (status === 'error') return 'red';
  return 'default';
}

function metric(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : value.toFixed(Number.isInteger(value) ? 0 : 2);
}

export function EvaluationPage() {
  const navigate = useNavigate();
  const [passwordInput, setPasswordInput] = useState('');
  const [password, setPassword] = useState(() => localStorage.getItem('futureHeadlines_adminPassword') ?? '');
  const [batches, setBatches] = useState<EvaluationBatchListItem[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [detail, setDetail] = useState<EvaluationDetail | null>(null);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [judgeText, setJudgeText] = useState('');
  const [copiedRunId, setCopiedRunId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('Evaluation Batch');
  const [runCount, setRunCount] = useState('10');
  const [concurrency, setConcurrency] = useState('10');
  const [playMinutes, setPlayMinutes] = useState('8');
  const [maxRounds, setMaxRounds] = useState('4');
  const [worldStateEnabled, setWorldStateEnabled] = useState(true);
  const [generateSummaries, setGenerateSummaries] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('deepseek');
  const [model, setModel] = useState(defaultModelForProvider('deepseek'));
  const [baseUrl, setBaseUrl] = useState(baseUrlForProvider('deepseek'));
  const [aiPlayers, setAiPlayers] = useState<AiDraft[]>([makeAiDraft(0), makeAiDraft(1)]);

  const adminFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-admin-password', password);
      if (init.body) headers.set('Content-Type', 'application/json');
      const response = await fetch(`${API_URL}${path}`, { ...init, headers });
      return readJson(response);
    },
    [password]
  );

  const loadBatches = useCallback(async () => {
    if (!password) return;
    const data = await adminFetch('/api/admin/evaluations');
    setBatches(data.batches ?? []);
    if (!selectedBatchId && data.batches?.[0]?.id) {
      setSelectedBatchId(data.batches[0].id);
    }
  }, [adminFetch, password, selectedBatchId]);

  const loadDetail = useCallback(async () => {
    if (!password || !selectedBatchId) return;
    const data = await adminFetch(`/api/admin/evaluations/${selectedBatchId}`);
    setDetail(data);
    setError('');
    if (!selectedRunId && data.runs?.[0]?.id) {
      setSelectedRunId(data.runs[0].id);
    }
  }, [adminFetch, password, selectedBatchId, selectedRunId]);

  useEffect(() => {
    loadBatches().catch((err: Error) => setError(err.message));
  }, [loadBatches]);

  useEffect(() => {
    loadDetail().catch((err: Error) => setError(err.message));
  }, [loadDetail]);

  useEffect(() => {
    if (!password || !selectedBatchId) return;
    const handle = window.setInterval(() => {
      loadDetail().catch((err: Error) => setError(err.message));
    }, 3000);
    return () => window.clearInterval(handle);
  }, [loadDetail, password, selectedBatchId]);

  const selectedRun = useMemo(
    () => detail?.runs.find((run) => run.id === selectedRunId) ?? detail?.runs[0] ?? null,
    [detail, selectedRunId]
  );

  const submitLogin = (event: FormEvent) => {
    event.preventDefault();
    const nextPassword = passwordInput.trim();
    localStorage.setItem('futureHeadlines_adminPassword', nextPassword);
    setPassword(nextPassword);
    setPasswordInput('');
    setError('');
  };

  const updateAiCount = (count: number) => {
    setAiPlayers((current) => {
      const next = current.slice(0, count);
      while (next.length < count) {
        next.push(makeAiDraft(next.length));
      }
      return next;
    });
  };

  const patchAi = (index: number, patch: Partial<AiDraft>) => {
    setAiPlayers((current) => current.map((player, i) => i === index ? { ...player, ...patch } : player));
  };

  const createBatch = async () => {
    setBusy(true);
    setError('');
    try {
      const parsedRunCount = Number(runCount);
      const parsedConcurrency = Number(concurrency) || parsedRunCount;
      const data = await adminFetch('/api/admin/evaluations', {
        method: 'POST',
        body: JSON.stringify({
          name,
          runCount: parsedRunCount,
          concurrency: parsedConcurrency,
          config: {
            playMinutes: Number(playMinutes),
            breakMinutes: 3,
            maxRounds: Number(maxRounds),
            timelineSpeedRatio: 60,
            worldStateEnabled,
            summaryConfig: {
              roundSummaries: generateSummaries,
              finalNarrative: generateSummaries,
            },
            llmConfig: { provider, model, baseUrl },
            aiPlayers: aiPlayers.map((player) => ({
              nickname: player.nickname,
              stylePrompt: player.stylePrompt,
              creativity: Number(player.creativity),
              submitEverySeconds: Number(player.submitEverySeconds),
              provider: player.provider,
              model: player.model,
            })),
          },
        }),
      });
      setDetail(data);
      setSelectedBatchId(data.batch.id);
      setSelectedRunId(data.runs?.[0]?.id ?? '');
      setJudgeText('');
      await loadBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create evaluation');
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async (runId: string) => {
    setBusy(true);
    setError('');
    try {
      const data = await adminFetch(`/api/admin/evaluations/${selectedBatchId}/runs/${runId}/prompt`);
      await navigator.clipboard.writeText(data.prompt);
      setCopiedRunId(runId);
      window.setTimeout(() => setCopiedRunId(''), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy prompt');
    } finally {
      setBusy(false);
    }
  };

  const saveJudgeResult = async () => {
    if (!selectedRun) return;
    setBusy(true);
    setError('');
    try {
      const data = await adminFetch(`/api/admin/evaluations/${selectedBatchId}/runs/${selectedRun.id}/judge-result`, {
        method: 'PUT',
        body: JSON.stringify({ judgeResult: judgeText }),
      });
      setDetail(data);
      setJudgeText('');
      await loadBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save judge result');
    } finally {
      setBusy(false);
    }
  };

  const handleProviderChange = (nextProvider: string) => {
    const normalized = nextProvider as AiProvider;
    setProvider(normalized);
    setModel(defaultModelForProvider(normalized));
    setBaseUrl(baseUrlForProvider(normalized));
  };

  if (!password) {
    return (
      <div className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-6">
        <Card padding="lg" className="w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Evaluation Mode</h1>
            <p className="text-sm text-gray-500">Admin password required</p>
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
        </Card>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] overflow-y-auto bg-gradient-to-b from-gray-50 to-gray-100/80 p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Evaluation Mode</h1>
            <p className="text-sm text-gray-500">Batch-run AI-only games and paste external judge JSON for aggregate scoring</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/admin')}>Admin</Button>
            <Button variant="secondary" onClick={() => loadDetail()} disabled={!selectedBatchId || busy}>Refresh</Button>
            <Button
              variant="ghost"
              onClick={() => {
                localStorage.removeItem('futureHeadlines_adminPassword');
                setPassword('');
                setDetail(null);
              }}
            >
              Logout
            </Button>
          </div>
        </header>

        {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Batches</h2>
                <Button variant="ghost" size="sm" onClick={() => loadBatches()}>Reload</Button>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {batches.map((batch) => (
                  <button
                    key={batch.id}
                    type="button"
                    onClick={() => {
                      setSelectedBatchId(batch.id);
                      setSelectedRunId('');
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selectedBatchId === batch.id ? 'border-indigo-200 bg-indigo-50' : 'border-gray-100 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-900">{batch.name}</span>
                      <Badge variant={statusVariant(batch.status)}>{batch.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {batch.judgedRuns}/{batch.runCount} judged · avg {metric(batch.averageScore)}
                    </div>
                  </button>
                ))}
                {batches.length === 0 && <p className="text-sm text-gray-400">No evaluation batches yet.</p>}
              </div>
            </Card>

            <Card className="space-y-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Create Batch</h2>
              <label className="block text-xs font-medium uppercase tracking-wider text-gray-400">
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm normal-case tracking-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-400">
                  Runs
                  <input type="number" min={1} max={50} value={runCount} onChange={(event) => setRunCount(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm normal-case tracking-normal text-gray-900" />
                </label>
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-400">
                  Parallel
                  <input type="number" min={1} max={50} value={concurrency} onChange={(event) => setConcurrency(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm normal-case tracking-normal text-gray-900" />
                </label>
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-400">
                  Play min
                  <input type="number" min={1} max={120} value={playMinutes} onChange={(event) => setPlayMinutes(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm normal-case tracking-normal text-gray-900" />
                </label>
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-400">
                  Rounds
                  <input type="number" min={1} max={20} value={maxRounds} onChange={(event) => setMaxRounds(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm normal-case tracking-normal text-gray-900" />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <DropdownSelect value={provider} options={PROVIDER_OPTIONS} onChange={handleProviderChange} ariaLabel="Game model provider" />
                <DropdownSelect value={model} options={modelOptionsForValue(provider, model)} onChange={setModel} ariaLabel="Game model" />
              </div>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900" />

              <div className="flex flex-wrap gap-3 text-sm text-gray-600">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={worldStateEnabled} onChange={(event) => setWorldStateEnabled(event.target.checked)} />
                  World state
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={generateSummaries} onChange={(event) => setGenerateSummaries(event.target.checked)} />
                  Summaries
                </label>
              </div>

              <label className="block text-xs font-medium uppercase tracking-wider text-gray-400">
                AI players
                <input type="number" min={1} max={16} value={aiPlayers.length} onChange={(event) => updateAiCount(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm normal-case tracking-normal text-gray-900" />
              </label>
              <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
                {aiPlayers.map((player, index) => (
                  <div key={index} className="space-y-2 rounded-lg border border-gray-100 p-3">
                    <input value={player.nickname} onChange={(event) => patchAi(index, { nickname: event.target.value })} className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900" />
                    <textarea value={player.stylePrompt} onChange={(event) => patchAi(index, { stylePrompt: event.target.value })} rows={2} className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900" />
                    <div className="grid grid-cols-2 gap-2">
                      <DropdownSelect
                        value={player.provider}
                        options={PROVIDER_OPTIONS}
                        onChange={(value) => {
                          const nextProvider = value as AiProvider;
                          patchAi(index, {
                            provider: nextProvider,
                            model: defaultModelForProvider(nextProvider),
                          });
                        }}
                        ariaLabel={`AI ${index + 1} provider`}
                      />
                      <DropdownSelect value={player.model} options={modelOptionsForValue(player.provider, player.model)} onChange={(value) => patchAi(index, { model: value })} ariaLabel={`AI ${index + 1} model`} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs text-gray-500">
                        Creativity
                        <input type="number" min={0} max={1} step={0.05} value={player.creativity} onChange={(event) => patchAi(index, { creativity: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900" />
                      </label>
                      <label className="text-xs text-gray-500">
                        Extra delay
                        <input type="number" min={0} max={600} value={player.submitEverySeconds} onChange={(event) => patchAi(index, { submitEverySeconds: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900" />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
              <Button fullWidth onClick={createBatch} disabled={busy}>Create And Start</Button>
            </Card>
          </aside>

          <main className="min-w-0 space-y-4">
            {detail ? (
              <>
                <Card className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold text-gray-900">{detail.batch.name}</h2>
                      <Badge variant={statusVariant(detail.batch.status)}>{detail.batch.status}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      {detail.aggregate.readyRuns} ready · {detail.aggregate.judgedRuns} judged · {detail.aggregate.runningRuns} running
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                      <div className="rounded-lg bg-gray-50 p-3">
                        <div className="text-xs text-gray-400">Mean</div>
                        <div className="text-xl font-bold text-gray-900">{metric(detail.aggregate.score.mean)}</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <div className="text-xs text-gray-400">Median</div>
                        <div className="text-xl font-bold text-gray-900">{metric(detail.aggregate.score.median)}</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <div className="text-xs text-gray-400">Stddev</div>
                        <div className="text-xl font-bold text-gray-900">{metric(detail.aggregate.score.stddev)}</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <div className="text-xs text-gray-400">Min</div>
                        <div className="text-xl font-bold text-gray-900">{metric(detail.aggregate.score.min)}</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <div className="text-xs text-gray-400">Max</div>
                        <div className="text-xl font-bold text-gray-900">{metric(detail.aggregate.score.max)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="max-h-56 overflow-y-auto rounded-lg bg-gray-50 p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Dimension Means</h3>
                    <div className="mt-2 space-y-1 text-sm">
                      {Object.entries(detail.aggregate.dimensionMeans).map(([key, value]) => (
                        <div key={key} className="flex justify-between gap-2">
                          <span className="truncate text-gray-600">{key.replace(/_/g, ' ')}</span>
                          <span className="font-medium text-gray-900">{metric(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
                  <Card className="min-w-0">
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Runs</h2>
                      <span className="text-xs text-gray-400">{detail.runs.length}</span>
                    </div>
                    <div className="max-h-[620px] overflow-auto">
                      <table className="w-full min-w-[760px] text-left text-sm">
                        <thead className="sticky top-0 bg-white text-xs uppercase tracking-wider text-gray-400">
                          <tr>
                            <th className="py-2 pr-3">Run</th>
                            <th className="py-2 pr-3">Status</th>
                            <th className="py-2 pr-3">Session</th>
                            <th className="py-2 pr-3">Headlines</th>
                            <th className="py-2 pr-3">Built-in top</th>
                            <th className="py-2 pr-3">Judge</th>
                            <th className="py-2 pr-3">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {detail.runs.map((run) => {
                            const topPlayer = [...run.players].sort((a, b) => b.totalScore - a.totalScore)[0];
                            return (
                              <tr key={run.id} className={selectedRun?.id === run.id ? 'bg-indigo-50/60' : ''}>
                                <td className="py-2 pr-3 font-medium text-gray-900">#{run.runIndex}</td>
                                <td className="py-2 pr-3"><Badge variant={statusVariant(run.status)}>{run.status}</Badge></td>
                                <td className="py-2 pr-3 text-gray-600">{run.joinCode ?? '-'} · {run.phase ?? '-'}</td>
                                <td className="py-2 pr-3 text-gray-600">{run.playerHeadlineCount}/{run.headlineCount}</td>
                                <td className="py-2 pr-3 text-gray-600">{topPlayer ? `${topPlayer.nickname} ${topPlayer.totalScore}` : '-'}</td>
                                <td className="py-2 pr-3 text-gray-600">{run.overallScore === null ? '-' : `${metric(run.overallScore)} (${run.confidence ?? '-'})`}</td>
                                <td className="py-2 pr-3">
                                  <div className="flex flex-wrap gap-1.5">
                                    <Button variant="ghost" size="sm" onClick={() => setSelectedRunId(run.id)}>Select</Button>
                                    <Button variant="secondary" size="sm" onClick={() => copyPrompt(run.id)} disabled={busy || run.headlineCount === 0}>
                                      {copiedRunId === run.id ? 'Copied' : 'Copy Prompt'}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => run.joinCode && navigate(`/admin/summary/${run.joinCode}`)} disabled={!run.joinCode}>Summary</Button>
                                  </div>
                                  {run.error && <div className="mt-1 text-xs text-red-500">{run.error}</div>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>

                  <div className="space-y-4">
                    <Card className="space-y-3">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Judge JSON</h2>
                      {selectedRun ? (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-gray-900">Run #{selectedRun.runIndex}</div>
                              <div className="text-xs text-gray-500">{selectedRun.joinCode ?? 'No session'} · {selectedRun.status}</div>
                            </div>
                            <Button variant="secondary" size="sm" onClick={() => copyPrompt(selectedRun.id)} disabled={busy || selectedRun.headlineCount === 0}>Copy Prompt</Button>
                          </div>
                          <textarea
                            value={judgeText}
                            onChange={(event) => setJudgeText(event.target.value)}
                            placeholder="Paste the compact JSON object from the judge model here..."
                            className="h-56 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          />
                          <Button fullWidth onClick={saveJudgeResult} disabled={busy || !judgeText.trim()}>Save Judge Result</Button>
                        </>
                      ) : (
                        <p className="text-sm text-gray-400">Select a run to paste judge output.</p>
                      )}
                    </Card>

                    <Card className="space-y-4">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Aggregate Signals</h2>
                      <div>
                        <h3 className="text-sm font-semibold text-gray-700">AI built-in score averages</h3>
                        <div className="mt-2 space-y-1 text-sm">
                          {detail.aggregate.aiScoreAverages.map((item) => (
                            <div key={item.nickname} className="flex justify-between gap-2">
                              <span className="truncate text-gray-600">{item.nickname}</span>
                              <span className="font-medium text-gray-900">{metric(item.meanTotalScore)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="max-h-60 overflow-y-auto">
                        <h3 className="text-sm font-semibold text-gray-700">Top recommendations</h3>
                        <div className="mt-2 space-y-2">
                          {detail.aggregate.topRecommendations.map((item) => (
                            <div key={item.text} className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
                              <span className="font-medium text-gray-900">{item.count}x</span> {item.text}
                            </div>
                          ))}
                          {detail.aggregate.topRecommendations.length === 0 && <p className="text-sm text-gray-400">No judge recommendations yet.</p>}
                        </div>
                      </div>
                    </Card>
                  </div>
                </div>
              </>
            ) : (
              <Card className="flex min-h-[360px] items-center justify-center text-sm text-gray-400">
                Select or create an evaluation batch.
              </Card>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
