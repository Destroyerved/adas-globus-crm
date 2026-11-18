import { formatNumber, type ScoreBreakdownItem, type ScoringCategory } from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';

const CATEGORY_LABEL: Record<ScoringCategory, string> = {
  fit: 'Firm fit',
  engagement: 'Engagement',
  negative: 'Deduction',
};

function scoreTone(score: number): 'success' | 'brand' | 'neutral' {
  if (score >= 60) return 'success';
  if (score >= 30) return 'brand';
  return 'neutral';
}

/**
 * Explainable rule-based score panel for Leads and Contacts (PRD 4.5, 4.16).
 */
export function ScorePanel({
  score,
  breakdown,
}: {
  score: number | null | undefined;
  breakdown: ScoreBreakdownItem[] | undefined;
}) {
  const numericScore = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  const items = Array.isArray(breakdown) ? breakdown : [];

  return (
    <Panel
      title="Fit & engagement score"
      padded
      actions={
        <StatusBadge tone={scoreTone(numericScore)}>
          <span className="tabular-nums" data-testid="record-score-value">
            {formatNumber(numericScore)} / 100
          </span>
        </StatusBadge>
      }
    >
      <div className="space-y-[10px]" data-testid="record-score-panel">
        {items.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-2">
            No scoring rules matched yet. Scores update when firm details, title or calls change.
          </p>
        ) : (
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {items.map((item) => {
              const positive = item.points >= 0;
              return (
                <li
                  key={`${item.ruleId}-${item.ruleName}`}
                  className="py-[8px] first:pt-0 last:pb-0 flex items-start justify-between gap-[8px] text-[13px]"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-ink break-words">{item.ruleName}</div>
                    <div className="text-[12px] text-ink-3">{CATEGORY_LABEL[item.category]}</div>
                  </div>
                  <span
                    className={`tabular-nums font-semibold shrink-0 ${positive ? 'text-success' : 'text-danger'}`}
                  >
                    {positive ? `+${formatNumber(item.points)}` : formatNumber(item.points)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
