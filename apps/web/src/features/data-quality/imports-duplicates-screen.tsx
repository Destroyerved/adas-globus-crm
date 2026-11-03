import { useState } from 'react';
import { CheckCircle2, GitMerge, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';

export function ImportsDuplicatesScreen() {
  const [importStage, setImportStage] = useState<'dry_run' | 'executed' | 'rolled_back'>('dry_run');
  const [mergeState, setMergeState] = useState<'pending' | 'merged' | 'undone'>('pending');

  return (
    <div
      className="px-[16px] py-[20px] md:px-[28px] md:py-[24px] max-w-[1600px] mx-auto space-y-[20px]"
      data-testid="imports-duplicates-screen"
    >
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[16px]">
        <div>
          <div className="eyebrow-rule mb-[6px]">Data Hygiene & Cutover (PRD 4.8, 4.9, 10)</div>
          <h1 className="text-h1 text-ink m-0">Imports, Duplicates & Bigin Cutover</h1>
          <p className="text-[13.5px] text-ink-2 mt-[4px] mb-0">
            Dry-run CSV previews, reversible contact merges, and 100% Bigin migration
            reconciliation.
          </p>
        </div>

        <StatusBadge tone="brand">Suppression Always Wins (A13)</StatusBadge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
        {/* CSV Import Dry-Run & Rollback (A5 & A13) */}
        <Panel className="p-[20px] space-y-[14px]">
          <div className="flex items-center justify-between gap-[8px]">
            <div>
              <div className="text-eyebrow text-ink-3">PRD 4.9 · CSV IMPORT ENGINE (A5)</div>
              <h2 className="text-h2 text-ink m-0 mt-[2px]">Dry-Run Preview & Rollback</h2>
            </div>
            <StatusBadge
              tone={
                importStage === 'executed'
                  ? 'success'
                  : importStage === 'rolled_back'
                    ? 'warning'
                    : 'info'
              }
            >
              {importStage === 'dry_run'
                ? 'Dry-Run Ready'
                : importStage === 'executed'
                  ? 'Import Completed'
                  : 'Rolled Back'}
            </StatusBadge>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-[10px]">
            <div className="rounded-[8px] border border-line bg-bg-alt p-[10px]">
              <div className="text-[11.5px] text-ink-2">New Contacts</div>
              <div className="text-[18px] font-[650] text-ink tabular-nums">142</div>
            </div>
            <div className="rounded-[8px] border border-line bg-bg-alt p-[10px]">
              <div className="text-[11.5px] text-ink-2">Updated Blank</div>
              <div className="text-[18px] font-[650] text-ink tabular-nums">18</div>
            </div>
            <div className="rounded-[8px] border border-line bg-bg-alt p-[10px]">
              <div className="text-[11.5px] text-ink-2">Duplicates Skipped</div>
              <div className="text-[18px] font-[650] text-ink tabular-nums">9</div>
            </div>
            <div className="rounded-[8px] border border-line bg-bg-alt p-[10px]">
              <div className="text-[11.5px] text-ink-2">Suppressed Blocked</div>
              <div className="text-[18px] font-[650] text-primary-ink tabular-nums">4</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-[8px]">
            <Button size="sm" variant="primary" onClick={() => setImportStage('executed')}>
              <Upload size={14} aria-hidden="true" />
              <span>Execute Verified Import</span>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setImportStage('rolled_back')}>
              <RotateCcw size={14} aria-hidden="true" />
              <span>Rollback Import Job</span>
            </Button>
          </div>
        </Panel>

        {/* Duplicate Review Queue & Merge with Undo (A6) */}
        <Panel className="p-[20px] space-y-[14px]">
          <div className="flex items-center justify-between gap-[8px]">
            <div>
              <div className="text-eyebrow text-ink-3">PRD 4.8 · DUPLICATE REVIEW QUEUE (A6)</div>
              <h2 className="text-h2 text-ink m-0 mt-[2px]">Contact Merge with Snapshot Undo</h2>
            </div>
            <StatusBadge tone={mergeState === 'merged' ? 'success' : 'neutral'}>
              {mergeState === 'pending'
                ? '1 Candidate Pair'
                : mergeState === 'merged'
                  ? 'Merged (Snapshot Saved)'
                  : 'Merge Undone'}
            </StatusBadge>
          </div>

          <div className="rounded-[10px] border border-line p-[14px] space-y-[8px]">
            <div className="text-[13.5px] font-[600] text-ink">
              Jane Patel (jane.patel@acmetax.example.com) ↔ J. Patel (jpatel@acmetax.example.com)
            </div>
            <div className="text-[12.5px] text-ink-2">
              Match reason: Normalized domain <code className="text-mono">acmetax.example.com</code>{' '}
              + Trigram name similarity 0.91 · Moves secondary emails, deals, tasks, and sequence
              history to survivor.
            </div>
            <div className="flex flex-wrap gap-[8px] pt-[4px]">
              <Button size="sm" variant="primary" onClick={() => setMergeState('merged')}>
                <GitMerge size={14} aria-hidden="true" />
                <span>Merge into Survivor</span>
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setMergeState('undone')}>
                <RotateCcw size={14} aria-hidden="true" />
                <span>Undo Merge from Snapshot</span>
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      {/* Bigin Cutover Reconciliation (PRD §10) */}
      <Panel className="p-[20px] space-y-[12px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <div>
            <div className="text-eyebrow text-ink-3">PRD 10 · ZOHO BIGIN MIGRATION & CUTOVER</div>
            <h2 className="text-h2 text-ink m-0 mt-[2px]">
              Bigin Staging Dry-Run & Reconciliation
            </h2>
          </div>
          <StatusBadge tone="success">
            <CheckCircle2 size={12} className="inline mr-[4px]" aria-hidden="true" />
            100% Reconciled · Legacy Contacts Flagged Non-Mailable (Q3)
          </StatusBadge>
        </div>
        <div className="text-[13px] text-ink-2">
          Companies matched: 5/5 · Contacts matched: 5/5 · Open deals matched: 3/3 · Pipeline
          monthly value matched: US$18,588/mo
        </div>
      </Panel>
    </div>
  );
}
