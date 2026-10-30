import * as React from 'react';
import { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { EmployeeLoadState } from '../../features/enterprise/use-workspace-employees';
import { EmployeeDetailPage } from '../../pages/enterprise/EmployeeDetailPage';

interface Props {
  workspace: EnterpriseWorkspace;
  employeeId: string;
  employeeLoad?: EmployeeLoadState;
  employeeStatusLoad?: EmployeeLoadState;
}

export function EmployeeDetailDrawer(props: Props): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = () => {
    if (props.workspace.canGoBack) props.workspace.goBack();
    else props.workspace.replaceRoute({ name: 'employees' });
  };

  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    if (!element) return;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return <dialog
    ref={dialog}
    className="ent-employee-drawer"
    aria-label="员工详情"
    aria-modal="true"
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}
  >
    <div className="ent-employee-drawer-panel">
      <header className="ent-employee-drawer-heading">
        <h2>员工详情</h2>
        <button ref={closeButton} type="button" className="ent-top-icon" aria-label="关闭员工详情" onClick={close}><X size={18} aria-hidden /></button>
      </header>
      <div className="ent-employee-drawer-body"><EmployeeDetailPage {...props} /></div>
    </div>
  </dialog>;
}
