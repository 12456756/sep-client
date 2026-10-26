import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';

interface IconHintProps {
  label: string;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export function IconHint({ label, children, side = 'right' }: IconHintProps): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="ent-icon-hint" side={side} sideOffset={8}>
            {label}
            <Tooltip.Arrow className="ent-icon-hint-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
