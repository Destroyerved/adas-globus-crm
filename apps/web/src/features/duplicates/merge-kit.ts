import { formatNumber, type MergeEntity } from '@adas/shared';

/** Shared wording for the Duplicates screens (PRD 4.9; DESIGN 10). */

export const entityNoun = (entity: MergeEntity) => (entity === 'contact' ? 'Contact' : 'Company');

export const entityPlural = (entity: MergeEntity) =>
  entity === 'contact' ? 'contacts' : 'companies';

function singular(label: string): string {
  const lower = label.toLowerCase();
  if (lower.endsWith('entries')) return `${lower.slice(0, -7)}entry`;
  if (lower.endsWith('addresses')) return lower.slice(0, -2);
  return lower.endsWith('s') ? lower.slice(0, -1) : lower;
}

/** "1 deal, 12 timeline entries and 2 tasks" */
export function describeMoved(moved: { label: string; count: number }[]): string {
  const parts = moved
    .filter((m) => m.count > 0)
    .map(
      (m) =>
        `${formatNumber(m.count)} ${m.count === 1 ? singular(m.label) : m.label.toLowerCase()}`,
    );
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
