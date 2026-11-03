import { Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Panel } from '@/components/ui/panel.js';
import { EmptyState } from '@/components/ui/state-views.js';

export interface EmptyShowcaseScreenProps {
  onGoToLeads: () => void;
}

export function EmptyShowcaseScreen({ onGoToLeads }: EmptyShowcaseScreenProps) {
  return (
    <div className="space-y-[16px]" data-testid="empty-showcase-screen">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="kicker mb-[4px]">Prospecting workspace</div>
          <h1 className="text-display text-ink m-0">
            <strong>Leads</strong> <span className="text-ink-3 font-light">No leads</span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button variant="outline" onClick={onGoToLeads}>
            <Upload size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>Import leads</span>
          </Button>
          <Button variant="primary" onClick={onGoToLeads}>
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New lead</span>
          </Button>
        </div>
      </div>

      <Panel padded={false}>
        <EmptyState
          title="No leads yet"
          description="Import a spreadsheet or add one by hand to begin qualifying U.S. and Canadian CPA firms."
          actionLabel="Import leads"
          actionVariant="primary"
          onAction={onGoToLeads}
        />
      </Panel>
    </div>
  );
}
