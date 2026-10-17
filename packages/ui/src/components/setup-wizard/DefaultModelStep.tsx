import React from 'react';
import { Radio } from '@/components/ui/radio';
import type { EngineSnapshot } from './engineSetupModel';

export type ModelOption = { id: string; name: string };
export type ModelSelection = { providerID: string; modelID: string };

type DefaultModelStepProps = {
  engines: EngineSnapshot[];
  modelsByProvider: Map<string, ModelOption[]>;
  selection: ModelSelection | null;
  onSelect: (selection: ModelSelection) => void;
};

export const DefaultModelStep: React.FC<DefaultModelStepProps> = ({ engines, modelsByProvider, selection, onSelect }) => {
  return (
    <div className="flex flex-col gap-3">
      {engines.map(({ status }) => {
        const models = modelsByProvider.get(status.providerID) ?? [];
        const checked = selection?.providerID === status.providerID;
        return (
          <div key={status.engine} className="flex items-center gap-3 rounded-lg border border-border p-3">
            <Radio
              checked={checked}
              ariaLabel={status.displayName}
              disabled={models.length === 0}
              onChange={() => onSelect({ providerID: status.providerID, modelID: models[0].id })}
            />
            <span className="typography-ui-label flex-1">{status.displayName}</span>
            <select
              className="typography-meta rounded border border-border bg-background px-2 py-1"
              disabled={!checked || models.length === 0}
              value={(checked ? selection?.modelID : models[0]?.id) ?? ''}
              onChange={(event) => onSelect({ providerID: status.providerID, modelID: event.target.value })}
            >
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
};
