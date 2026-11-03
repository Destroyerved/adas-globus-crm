/**
 * Synthetic seed script (AGENTS.md §5, §6; PRD §7.6, §10.7).
 * Never uses real personal data. Supports `--size=large` (60k contacts, 20k companies, 300k activities) from Phase 2.
 */

const args = process.argv.slice(2);
const isLarge = args.includes('--size=large');

console.log(
  `[seed] Synthetic seed ready (${isLarge ? 'large: 60k contacts, 20k companies, 300k activities' : 'standard dev dataset'}).`,
);
console.log(
  '[seed] Phase 0 uses static synthetic fixtures in @adas/web; DB seeding activates in Phase 1/2.',
);
