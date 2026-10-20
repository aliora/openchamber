import React from 'react';

import { SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import type { HostOption } from '@/components/sections/shared/useHostOptions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

type EngineHostPickerProps = {
  hosts: readonly HostOption[];
  value: string;
  onChange: (hostId: string) => void;
};

export const EngineHostPicker: React.FC<EngineHostPickerProps> = ({ hosts, value, onChange }) => {
  const { t } = useI18n();
  const offered = hosts.filter((host) => host.reachable || host.id === value);
  if (offered.length < 2) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('engines.host.label')}>
        <SelectValue>{(selected) => offered.find((host) => host.id === selected)?.label ?? selected}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {offered.map((host) => (
          <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
