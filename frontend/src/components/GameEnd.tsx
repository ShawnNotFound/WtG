import { useRef, useState } from 'react';
import { Headline, Player, FinalSummary } from '../hooks/useSocket';
import { Card, SectionTitle, Button } from './ui';
import { ScoreBarChart } from './ScoreBarChart';
import { HeadlineFeed } from './HeadlineFeed';

interface GameEndProps {
  title: string;
  joinCode: string;
  players: Player[];
  headlines: Headline[];
  currentPlayerId: string;
  maxRounds: number;
  totalGameMins: number;
  currentGameMins: number;
  finalSummary: FinalSummary | null;
  focusHeadlineId?: string | null;
  focusSignal?: number;
  onBack: () => void;
  backLabel?: string;
}

export function GameEnd({
  title,
  players,
  headlines,
  currentPlayerId,
  maxRounds,
  totalGameMins,
  currentGameMins,
  finalSummary,
  focusHeadlineId = null,
  focusSignal = 0,
  onBack,
  backLabel = 'Leave game',
}: GameEndProps) {
  const realPlayers = players.filter((p) => p.nickname !== 'Archive');
  const realHeadlines = headlines;

  const isGenerating = !finalSummary || finalSummary.status === 'generating';
  const hasSummary =
    finalSummary?.status === 'completed' && finalSummary.summary;
  const reports = hasSummary ? finalSummary.summary?.reports ?? [] : [];

  const leaderboardRef = useRef<HTMLDivElement>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const handleDownloadPdf = async () => {
    if (!leaderboardRef.current) return;
    setGeneratingPdf(true);
    try {
      const [html2canvas, jsPDF] = await Promise.all([
        import('html2canvas').then((m) => m.default),
        import('jspdf').then((m) => m.jsPDF),
      ]);

      // build the pdf with native text rendering — leaderboard chart is captured as an image, everything else is real text so it stays selectable and doesn't slice across page breaks
      const pdf = new jsPDF('p', 'mm', 'a4');
      const margin = 15;
      const pageWidth = 210;
      const pageHeight = 297;
      const contentWidth = pageWidth - margin * 2;
      const bottomLimit = pageHeight - margin;
      let y = margin;

      const ptToMm = 0.3528;

      const ensureSpace = (needed: number) => {
        if (y + needed > bottomLimit) {
          pdf.addPage();
          y = margin;
        }
      };

      const writeText = (
        text: string,
        fontSize: number,
        opts?: {
          bold?: boolean;
          italic?: boolean;
          color?: [number, number, number];
          gapAfter?: number;
        }
      ) => {
        pdf.setFontSize(fontSize);
        pdf.setFont(
          'helvetica',
          opts?.bold ? 'bold' : opts?.italic ? 'italic' : 'normal'
        );
        const c = opts?.color ?? [33, 37, 41];
        pdf.setTextColor(c[0], c[1], c[2]);

        const lineHeight = fontSize * ptToMm * 1.35;
        const baselineOffset = fontSize * ptToMm * 0.85;
        const lines: string[] = pdf.splitTextToSize(text, contentWidth);

        for (const line of lines) {
          ensureSpace(lineHeight);
          pdf.text(line, margin, y + baselineOffset);
          y += lineHeight;
        }
        if (opts?.gapAfter) y += opts.gapAfter;
      };

      // header
      writeText(title || 'Future Headlines', 22, { bold: true, gapAfter: 1 });
      writeText(
        `${maxRounds} rounds - 20 years of history`,
        10,
        { color: [120, 120, 120], gapAfter: 6 }
      );

      // leaderboard
      writeText('Final Leaderboard', 14, {
        bold: true,
        color: [60, 60, 60],
        gapAfter: 2,
      });

      const canvas = await html2canvas(leaderboardRef.current, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
      });
      const imgWidth = contentWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      ensureSpace(imgHeight);
      pdf.addImage(
        canvas.toDataURL('image/png'),
        'PNG',
        margin,
        y,
        imgWidth,
        imgHeight
      );
      y += imgHeight + 8;

      // timeline — iterate all headlines from props, not the scroll viewport
      writeText('Timeline', 14, {
        bold: true,
        color: [60, 60, 60],
        gapAfter: 3,
      });

      for (const h of realHeadlines) {
        const dateStr = h.inGameSubmittedAt
          ? new Date(h.inGameSubmittedAt).toLocaleDateString('en-US', {
              month: 'long',
              year: 'numeric',
            })
          : '';
        // keep the meta line and at least one line of headline together
        ensureSpace(12);
        writeText(`${h.playerNickname}  ·  R${h.roundNo}  ·  ${dateStr}`, 8, {
          color: [120, 120, 120],
        });
        writeText(h.text, 10, { gapAfter: 3 });
      }

      // experience reports
      if (hasSummary && reports.length > 0) {
        y += 4;
        writeText('Experience Reports From These Years', 14, {
          bold: true,
          color: [60, 60, 60],
          gapAfter: 2,
        });
        writeText(
          'Three fictional characters who lived through your timeline.',
          9,
          { color: [120, 120, 120], gapAfter: 5 }
        );

        for (let i = 0; i < reports.length; i++) {
          const r = reports[i];
          // don't strand a character header at the bottom of a page
          ensureSpace(35);
          writeText(r.character.name, 12, { bold: true });
          writeText(r.character.role, 9, {
            italic: true,
            color: [100, 100, 100],
          });
          writeText(r.character.era, 8, {
            color: [140, 140, 140],
            gapAfter: 3,
          });
          writeText(r.story, 10, { gapAfter: 3 });
          if (r.themes_touched.length > 0) {
            writeText(`Themes: ${r.themes_touched.join(', ')}`, 8, {
              color: [120, 120, 120],
            });
          }
          if (i < reports.length - 1) y += 6;
        }
      }

      const date = new Date().toISOString().slice(0, 10);
      const titleSlug = (title || 'future-headlines')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'future-headlines';
      pdf.save(`${titleSlug}-${date}.pdf`);
    } catch (err) {
      console.error('Failed to generate PDF:', err);
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <main className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-800">Game Complete</h1>
            <p className="text-sm text-gray-400 mt-1">
              {title || 'Future Headlines'} &middot; {maxRounds} rounds &middot; 20 years of history
            </p>
          </div>

          <Card padding="md">
            <SectionTitle>Final Leaderboard</SectionTitle>
            <div ref={leaderboardRef}>
              <ScoreBarChart
                players={realPlayers}
                currentPlayerId={currentPlayerId}
                totalGameMins={totalGameMins}
                currentGameMins={currentGameMins}
                phase="BREAK"
              />
            </div>
          </Card>

          {/* headlines list (replaces the old game statistics card) */}
          <div className="h-[400px]">
            <HeadlineFeed
              headlines={realHeadlines}
              currentPlayerId={currentPlayerId}
              focusHeadlineId={focusHeadlineId}
              focusSignal={focusSignal}
            />
          </div>

          <Card padding="md">
            <SectionTitle>Experience Reports From These Years</SectionTitle>

            {isGenerating && (
              <div className="py-6">
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-200 border-t-indigo-500" />
                  <span>Writing the experience reports...</span>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="h-3 bg-gray-100 rounded animate-pulse w-full" />
                  <div className="h-3 bg-gray-100 rounded animate-pulse w-5/6" />
                  <div className="h-3 bg-gray-100 rounded animate-pulse w-4/6" />
                  <div className="h-3 bg-gray-100 rounded animate-pulse w-full" />
                  <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
                </div>
                <p className="text-xs text-gray-400 mt-4">
                  The AI is writing first-person accounts from different characters living through your timeline. This may take 30-60 seconds.
                </p>
              </div>
            )}

            {finalSummary?.status === 'error' && (
              <div className="py-4">
                <p className="text-sm text-red-500">Experience reports unavailable</p>
                {finalSummary.error && (
                  <p className="text-xs text-red-400 mt-1">{finalSummary.error}</p>
                )}
              </div>
            )}

            {hasSummary && reports.length > 0 && (
              <div className="space-y-8">
                <p className="text-xs text-gray-400">
                  Three fictional characters who lived through your timeline.
                </p>
                {reports.map((report, i) => (
                  <div key={i} className="space-y-3">
                    <div className="border-l-2 border-indigo-300 pl-3">
                      <div className="text-sm font-semibold text-gray-700">{report.character.name}</div>
                      <div className="text-xs text-gray-500">{report.character.role}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5">{report.character.era}</div>
                    </div>

                    <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                      {report.story}
                    </p>

                    {report.themes_touched.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {report.themes_touched.map((theme, j) => (
                          <span
                            key={j}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700"
                          >
                            {theme}
                          </span>
                        ))}
                      </div>
                    )}

                    {i < reports.length - 1 && <div className="border-t border-gray-100 pt-2" />}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="flex justify-center gap-3 pb-8 pt-6">
          <Button
            variant="primary"
            onClick={handleDownloadPdf}
            disabled={generatingPdf || isGenerating}
          >
            {generatingPdf ? 'Generating PDF...' : 'Download PDF'}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            {backLabel}
          </Button>
        </div>
      </div>
    </main>
  );
}
