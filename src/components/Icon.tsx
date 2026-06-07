import type { CSSProperties, ComponentType } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowUUpLeft,
  Bell,
  BellSlash,
  CaretDown,
  ChartBar,
  ChartLine,
  Check,
  CheckCircle,
  Clock,
  ClockCountdown,
  Cube,
  Eye,
  FileCode,
  Flask,
  Gauge,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Info,
  Lightbulb,
  MagnifyingGlass,
  PlugsConnected,
  Plus,
  Pulse,
  ShieldCheck,
  Sliders,
  Sparkle,
  Stack,
  TreeStructure,
  Warning,
  WarningCircle,
  Wrench,
  X,
  type IconWeight,
} from '@phosphor-icons/react';

// Friendly name → Phosphor React component. Names mirror the prototype's icon
// layer (design/project/assets/icons.js) so usage matches the design's icon
// choices. The production app uses @phosphor-icons/react instead of the
// prototype's inline-SVG set, matching the prototype's weight and sizing.
const ICONS: Record<string, ComponentType<{ size?: string | number; weight?: IconWeight }>> = {
  signal: Pulse,
  levels: ChartBar,
  gauge: Gauge,
  chart: ChartLine,
  search: MagnifyingGlass,
  warning: Warning,
  critical: WarningCircle,
  check: Check,
  'check-circle': CheckCircle,
  bell: Bell,
  'bell-off': BellSlash,
  pr: GitPullRequest,
  branch: GitBranch,
  commit: GitCommit,
  sparkle: Sparkle,
  plug: PlugsConnected,
  cube: Cube,
  timeline: ClockCountdown,
  logs: Stack,
  flask: Flask,
  shield: ShieldCheck,
  undo: ArrowUUpLeft,
  tree: TreeStructure,
  eye: Eye,
  'arrow-right': ArrowRight,
  'arrow-left': ArrowLeft,
  'chevron-down': CaretDown,
  close: X,
  plus: Plus,
  info: Info,
  'file-code': FileCode,
  external: ArrowSquareOut,
  lightbulb: Lightbulb,
  wrench: Wrench,
  archive: Archive,
  clock: Clock,
  sliders: Sliders,
};

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: string;
  className?: string;
  style?: CSSProperties;
  /** Phosphor weight; the prototype's friendly geometry maps to 'regular'. */
  weight?: IconWeight;
}

/**
 * Renders a Phosphor icon sized at 1em inside an <i>, so the prototype's
 * font-size based sizing rules (e.g. `.nav-item i{font-size:18px}`) and
 * `currentColor` continue to drive size and color.
 */
export function Icon({ name, className, style, weight = 'regular' }: IconProps) {
  const Glyph = ICONS[name] ?? Info;
  const cls = className ? `i-ic ${className}` : 'i-ic';
  return (
    <i className={cls} style={style} aria-hidden="true">
      <Glyph size="1em" weight={weight} />
    </i>
  );
}
