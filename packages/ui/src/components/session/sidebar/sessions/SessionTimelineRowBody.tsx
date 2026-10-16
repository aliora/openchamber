import React from 'react';
import { RowMarkTooltip } from './RowMarkTooltip';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { cn } from '@/lib/utils';
import { PROJECT_ICON_MAP, resolveProjectColor, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';

type TimelineRowProject = {
  id: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type Props = {
  /** One-line rows (tree rows, Chats, the Tree view's Pinned and In work):
      title and meta on one line, no branch line. */
  compact?: boolean;
  /** Set in Pinned and In work, where projects mix: the second line opens
      with this project's icon. Rows under their project header pass null. */
  project: TimelineRowProject | null;
  /** The project's name, spoken and shown on hover for its icon. */
  projectLabel: string | null;
  title: React.ReactNode;
  titleClassName: string;
  branchLabel: string | null;
  /** Set when the branch label is an isolated space's name: the second line
      then carries the space's container mark, with this as its accessible
      name, where a branch shows the branch icon. */
  spaceMark?: string | null;
  /** Replaces the branch on the second line (a run row puts its mark and
      lane count there). */
  metaLineLead?: React.ReactNode;
  statusDot: React.ReactNode;
  /**
   * Two-line rows: the session's state in a word ("Needs permission",
   * "Running"), shown after the status mark. Null while idle.
   */
  statusLabel?: string | null;
  /** Classes for the state word: attention states take their status colour. */
  statusLabelClassName?: string;
  /** Pin glyph shown in the meta cluster while the row is pinned. */
  pinnedMarker: React.ReactNode;
  /** Elapsed-turn counter while running/unread, otherwise the compact date. */
  timeSlot: React.ReactNode;
  directoryIndicator: React.ReactNode;
  prBadge: React.ReactNode;
  zombieIndicator: React.ReactNode;
  /** Goal status glyph; opens the second line's state cluster, so it stays
      visible while a turn runs and while the hover actions cover line one. */
  goal?: React.ReactNode;
  badges: React.ReactNode;
  /** Jev's "looks done" check: it sits in the time cluster, where the hover
      Done action appears, left of the status dot so the dot stays by the time. */
  doneHint?: React.ReactNode;
  /** Provider of the session's model; its logo closes the second line. */
  providerId?: string | null;
  /** Reserves room for permanently shown action buttons on the title line. */
  metaPaddingClass?: string;
  hideMetaOnHoverClass: string;
  /** Sets how far hover-revealed actions reach into the title line
      (`--oc-actions-reserve`). */
  actionsReserveClass?: string;
  /** Fades the title's tail away under hover-revealed actions. */
  actionsMaskClass?: string;
};

// Only rows whose project carries a custom image pay for the theme
// subscription the image resolution needs.
const ProjectImageIcon: React.FC<{ project: TimelineRowProject; fallback: React.ReactNode }> = ({ project, fallback }) => {
  const { currentTheme } = useThemeSystem();
  return <ProjectIconImage
    project={{ id: project.id, iconImage: project.iconImage ?? null }}
    options={{ themeVariant: currentTheme.metadata.variant, iconColor: currentTheme.colors.surface.foreground }}
    className="h-full w-full object-contain"
    fallback={fallback}
  />;
};

const TimelineProjectIcon: React.FC<{ project: TimelineRowProject; label: string | null }> = ({ project, label }) => {
  const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = resolveProjectColor(project.color);
  const glyph = iconName
    ? <Icon name={iconName} className={cn('h-3 w-3', !iconColor && 'text-muted-foreground/75')} style={iconColor ? { color: iconColor } : undefined} />
    : <Icon name="folder" className="h-3 w-3 text-muted-foreground/75" style={iconColor ? { color: iconColor } : undefined} />;
  // The icon is the row's only word for its project, so it speaks.
  const labelProps = label ? { role: 'img', 'aria-label': label } : {};
  const mark = project.iconImage
    ? <span
      className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
      style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
      {...labelProps}
    >
      <ProjectImageIcon project={project} fallback={glyph} />
    </span>
    : <span className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center" {...labelProps}>{glyph}</span>;
  return label ? <RowMarkTooltip label={label}>{mark}</RowMarkTooltip> : mark;
};

const LineSeparator: React.FC = () => <span aria-hidden className="flex-shrink-0 text-muted-foreground/40">·</span>;

// Two lines: the title, then the session's state and time followed by where
// it runs (the project in the zones where projects mix, then the branch),
// with the goal, pull-request state, badges and engine at the end. The
// project header above names the project for rows listed under it.
export const SessionTimelineRowBody: React.FC<Props> = ({
  compact = false,
  project,
  projectLabel,
  title,
  titleClassName,
  branchLabel,
  spaceMark = null,
  metaLineLead = null,
  statusDot,
  statusLabel = null,
  statusLabelClassName,
  pinnedMarker,
  timeSlot,
  directoryIndicator,
  prBadge,
  zombieIndicator,
  goal = null,
  badges,
  doneHint = null,
  providerId,
  metaPaddingClass,
  hideMetaOnHoverClass,
  actionsReserveClass,
  actionsMaskClass,
}) => {
  // Compact rows have no second line, so their badges ride in the meta
  // cluster: the hover actions overlay that cluster, and anything placed
  // after it would sit underneath them.
  const meta = <span className={cn('ms-auto flex flex-shrink-0 items-center gap-1 transition-opacity', metaPaddingClass, hideMetaOnHoverClass)}>
    {compact ? goal : null}
    {compact ? zombieIndicator ?? prBadge : null}
    {compact ? badges : null}
    {directoryIndicator}
    {pinnedMarker}
    {doneHint}
    {statusDot}
    <span className="typography-micro leading-none text-muted-foreground/50 tabular-nums">{timeSlot}</span>
  </span>;
  const titleLine = (
    <div dir="auto" className={cn('oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label font-normal', actionsMaskClass, titleClassName)}>{title}</div>
  );
  if (compact) {
    return <div className={cn('@container relative flex w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      {titleLine}
      {meta}
    </div>;
  }
  // The title line keeps only what the hover actions may cover: the
  // directory's action, the pin and the done hint. Permanently shown actions
  // (touch layouts) reserve their room here even when it is empty.
  const titleMeta = directoryIndicator || pinnedMarker || doneHint || metaPaddingClass
    ? <span className={cn('ms-auto flex flex-shrink-0 items-center gap-1 transition-opacity', metaPaddingClass, hideMetaOnHoverClass)}>
      {directoryIndicator}
      {pinnedMarker}
      {doneHint}
    </span>
    : null;
  // Beside a project name the branch keeps its width up to 60% of the line,
  // so the project name gives way first: the branch is what tells two
  // sessions of one project apart.
  const branch = branchLabel ? (
    <span className={cn('flex min-w-0 items-center gap-1', project && 'max-w-[60%] shrink-0')}>
      {spaceMark
        // `Icon` hides itself from assistive tech; the space's mark is the row's only word for "space", so it speaks.
        ? <Icon name="box-3" className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" aria-hidden={false} role="img" aria-label={spaceMark} />
        : <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />}
      <span dir="auto" className="min-w-0 truncate">{branchLabel}</span>
    </span>
  ) : null;
  // Where the session runs: a run row's lead, or the project (only where
  // projects mix) and the branch.
  const location = metaLineLead ?? (project || branch ? (
    <span className="flex min-w-0 items-center gap-1">
      {project ? (
        <span className="flex min-w-0 items-center gap-1">
          <TimelineProjectIcon project={project} label={projectLabel} />
          {projectLabel ? <span dir="auto" aria-hidden className="min-w-0 truncate">{projectLabel}</span> : null}
        </span>
      ) : null}
      {project && branch ? <LineSeparator /> : null}
      {branch}
    </span>
  ) : null);
  return <div className="flex w-full min-w-0 flex-col gap-px">
    {/* Fixed 20px title line: the hover actions are positioned against the
        row from outside and rely on this height to sit exactly on it. */}
    <div className={cn('@container relative flex h-5 w-full min-w-0 items-center gap-1', actionsReserveClass)}>
      {titleLine}
      {titleMeta}
    </div>
    {/* Fixed 16px second line, always rendered: a row without a branch,
        a model or badges keeps the height of its neighbours, so the list
        does not shift when a branch or a badge arrives and the virtualizer's
        per-kind size estimate stays exact. The hover actions sit on the
        title line, so the state and time stay readable under the pointer. */}
    <div className="flex h-4 w-full min-w-0 items-center gap-1 typography-micro text-muted-foreground/60">
      {statusDot}
      {statusLabel ? <span className={cn('flex-shrink-0 whitespace-nowrap', statusLabelClassName)}>{statusLabel}</span> : null}
      <span dir="auto" className="flex-shrink-0 leading-none tabular-nums">{timeSlot}</span>
      {location ? <><LineSeparator />{location}</> : null}
      <span className="ms-auto flex flex-shrink-0 items-center gap-1 ps-1">
        {goal}
        {zombieIndicator ?? prBadge}
        {badges}
        {/* PR-icon size: a 16px box leaves the logo's own inner margin
            wide enough to pull it visibly in from the time above. */}
        {providerId ? <ProviderLogo providerId={providerId} className="h-3 w-3 flex-shrink-0 opacity-45" /> : null}
      </span>
    </div>
  </div>;
};
