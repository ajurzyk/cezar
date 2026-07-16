import {
  BellIcon,
  BookmarkIcon,
  BotIcon,
  FileCogIcon,
  GaugeIcon,
  KeyboardIcon,
  PaletteIcon,
  PlugIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import { CenteredState } from '@/components/centered-state'
import { AgentConfigSection } from './agent-config-section'
import { AgentsSection } from './agents-section'
import { AppearanceSection } from './appearance'
import { BookmarkletsSection } from './bookmarklets-section'
import { McpSection } from './mcp-section'
import { NotificationsSection } from './notifications-section'
import { ResourcesSection } from './resources-section'

/**
 * The Settings section registry (R6 Step 1.3, spec §"Settings"): the ONE place a section is
 * declared. The shell renders the section nav and the routes from this list, so adding a
 * section later is one entry here — no layout work, no route wiring.
 *
 * `hidden` sections are declared but not routed and not listed: they exist so the plan is
 * visible in code (`keyboard` — later phase; `notifications` unhid in Step 1.7, `mcp` shipped
 * with the agent-config feature #404) and so unhiding is a one-word diff.
 */

export type SettingsSectionId =
  | 'bookmarklets'
  | 'appearance'
  | 'agents'
  | 'agent-config'
  | 'resources'
  | 'mcp'
  | 'notifications'
  | 'keyboard'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the shell's desktop header and the index cards share it. */
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType
  /** Declared but not yet implemented: no nav entry, no route (the URL is honestly a 404). */
  hidden?: boolean
}

/** A registry entry whose real section arrives in a later Step — routable, honest about it. */
function comingSoon(title: string, Icon: ComponentType<SVGProps<SVGSVGElement>>): ComponentType {
  return function ComingSoonSection() {
    return (
      <CenteredState
        icon={<Icon />}
        tone="neutral"
        title={title}
        subtitle="This section arrives in a later phase of the redesign."
        heading="h2"
      />
    )
  }
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'bookmarklets',
    title: 'Bookmarklets',
    description: 'Launch skills from a GitHub PR or issue.',
    icon: BookmarkIcon,
    component: BookmarkletsSection,
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, accent and density.',
    icon: PaletteIcon,
    component: AppearanceSection,
  },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Default runner, models and system prompt.',
    icon: BotIcon,
    component: AgentsSection,
  },
  {
    id: 'agent-config',
    title: 'Agent config',
    description: 'Edit the coding agents’ own config files, per scope.',
    icon: FileCogIcon,
    component: AgentConfigSection,
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Parallel tasks and per-task memory limit.',
    icon: GaugeIcon,
    component: ResourcesSection,
  },
  {
    id: 'mcp',
    title: 'MCP',
    description: 'Model Context Protocol servers.',
    icon: PlugIcon,
    component: McpSection,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    description: 'Shortcuts.',
    icon: KeyboardIcon,
    component: comingSoon('Keyboard', KeyboardIcon),
    hidden: true,
  },
]

/** What the shell nav and the route table actually show — hidden sections drop out entirely. */
export function visibleSettingsSections(): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => !section.hidden)
}
