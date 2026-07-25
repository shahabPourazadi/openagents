import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bot,
  Briefcase,
  Calculator,
  ClipboardList,
  Code2,
  FlaskConical,
  Globe,
  GraduationCap,
  Hammer,
  HatGlasses,
  HeartPulse,
  Lightbulb,
  Megaphone,
  MessageSquare,
  MousePointer2,
  Music,
  Palette,
  PencilRuler,
  PenLine,
  Rocket,
  Scale,
  Search,
} from "lucide-react";

/** Canonical icon ids stored on agents (builtin agent.yaml + user_agents.icon). */
export const AGENT_ICON_OPTIONS = [
  { id: "mouse-pointer-2", label: "Agent", Icon: MousePointer2 },
  { id: "book", label: "Research", Icon: BookOpen },
  { id: "code", label: "Coding", Icon: Code2 },
  { id: "hat-glasses", label: "Agents", Icon: HatGlasses },
  { id: "hammer", label: "Builder", Icon: Hammer },
  { id: "pencil-ruler", label: "Skills", Icon: PencilRuler },
  { id: "search", label: "Search", Icon: Search },
  { id: "lightbulb", label: "Ideas", Icon: Lightbulb },
  { id: "pen", label: "Writing", Icon: PenLine },
  { id: "flask", label: "Science", Icon: FlaskConical },
  { id: "briefcase", label: "Business", Icon: Briefcase },
  { id: "graduation", label: "Education", Icon: GraduationCap },
  { id: "health", label: "Health", Icon: HeartPulse },
  { id: "scale", label: "Legal", Icon: Scale },
  { id: "megaphone", label: "Marketing", Icon: Megaphone },
  { id: "palette", label: "Design", Icon: Palette },
  { id: "calculator", label: "Finance", Icon: Calculator },
  { id: "globe", label: "Web", Icon: Globe },
  { id: "bot", label: "Assistant", Icon: Bot },
  { id: "chat", label: "Support", Icon: MessageSquare },
  { id: "clipboard", label: "Ops", Icon: ClipboardList },
  { id: "music", label: "Creative", Icon: Music },
  { id: "rocket", label: "Product", Icon: Rocket },
] as const;

export type AgentIconId = (typeof AGENT_ICON_OPTIONS)[number]["id"];

const PACK_ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  AGENT_ICON_OPTIONS.map((opt) => [opt.id, opt.Icon])
);

export const DEFAULT_AGENT_ICON: AgentIconId = "hat-glasses";
/** Default icon for library skills (sidebar Skills). */
export const DEFAULT_SKILL_ICON: AgentIconId = "pencil-ruler";

/** Resolve a stored agent icon id to a Lucide component. */
export function agentIconComponent(icon?: string | null): LucideIcon {
  // Legacy id from before the Agents section switched to hat-glasses.
  if (icon === "package") return HatGlasses;
  if (icon && PACK_ICON_MAP[icon]) return PACK_ICON_MAP[icon];
  return HatGlasses;
}

/** Resolve a stored skill icon id (same catalog as agents). */
export function skillIconComponent(icon?: string | null): LucideIcon {
  if (icon && PACK_ICON_MAP[icon]) return PACK_ICON_MAP[icon];
  return PencilRuler;
}

export function isAgentIconId(value: string): value is AgentIconId {
  return value in PACK_ICON_MAP;
}
