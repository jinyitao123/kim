import { registerExtension as registerEnterprise } from '../../assets/extensions/gooeypi-enterprise'
import { registerExtension as registerTeamDevelopment } from '../../assets/extensions/gooeypi-team-development'
import askUser from '../../assets/extensions/gooeypi-work-ask-user'
import { registerExtension as registerBrowser } from '../../assets/extensions/gooeypi-work-browser'
import { registerExtension as registerCollaboration } from '../../assets/extensions/gooeypi-work-collaboration'
import { registerExtension as registerSchedules } from '../../assets/extensions/gooeypi-work-schedules'
import type { CapabilityExtension } from './loom-capabilities'

/**
 * The extensions a Loom runtime receives through the capability host. Each
 * one registers only when its bridge environment is present, exactly as in
 * a Pi runtime; ask-user follows the same interactive opt-in as Pi Work.
 * Loaded on demand so the main bundle does not grow.
 */
export function loomCapabilityExtensions(options: { askUser: boolean }): CapabilityExtension[] {
  const extensions: CapabilityExtension[] = [
    { id: 'enterprise', register: registerEnterprise as unknown as CapabilityExtension['register'] },
    { id: 'team-development', register: registerTeamDevelopment as unknown as CapabilityExtension['register'] },
    { id: 'browser', register: registerBrowser as unknown as CapabilityExtension['register'] },
    { id: 'schedules', register: registerSchedules as unknown as CapabilityExtension['register'] },
    { id: 'collaboration', register: registerCollaboration as unknown as CapabilityExtension['register'] },
  ]
  if (options.askUser) extensions.push({ id: 'ask-user', register: (pi) => askUser(pi as never) })
  return extensions
}
