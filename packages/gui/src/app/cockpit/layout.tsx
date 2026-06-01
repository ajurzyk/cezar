import { CockpitTabs } from './cockpit-tabs';

/**
 * Phase 5 — shared layout for the cockpit. Adds a "Runs / Runners" tab strip
 * so the workers page lives alongside the run list without a sidebar churn.
 *
 * The detail page (`/cockpit/[runId]`) renders its own full-bleed shell —
 * `CockpitTabs` checks the current pathname client-side and hides itself on
 * detail routes so the tabs don't intrude on the run view.
 */
export default function CockpitLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <CockpitTabs />
      {children}
    </div>
  );
}
