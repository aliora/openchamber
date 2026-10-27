import React from 'react';
import type { EngineLogo } from '@/lib/engineAppearance';
import { cn } from '@/lib/utils';
import { EngineLogoMark } from './EngineLogoMark';

interface LogoChoiceGridProps {
  choices: readonly EngineLogo[];
  selected: EngineLogo;
  name: string;
  ariaLabel: string;
  defaultLabel: string;
  /** What the `default` choice shows: the official logo or the kind icon. */
  renderDefault: () => React.ReactNode;
  onSelect: (logo: EngineLogo) => void;
}

export const LogoChoiceGrid: React.FC<LogoChoiceGridProps> = ({ choices, selected, name, ariaLabel, defaultLabel, renderDefault, onSelect }) => (
  <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
    {choices.map((logo) => (
      <button
        key={logo}
        type="button"
        role="radio"
        aria-checked={logo === selected}
        aria-label={logo === 'default' ? defaultLabel : logo}
        onClick={() => onSelect(logo)}
        className={cn(
          'flex size-8 items-center justify-center rounded-md border border-[var(--interactive-border)] transition-colors hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          logo === selected && 'border-primary bg-[var(--interactive-selection)]',
        )}
      >
        {logo === 'default' ? renderDefault() : <EngineLogoMark logo={logo} name={name} className="size-4" />}
      </button>
    ))}
  </div>
);
