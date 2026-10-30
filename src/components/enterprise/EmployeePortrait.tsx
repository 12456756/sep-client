import React from 'react';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { employeeAppearance } from '../../features/enterprise/employee-appearance';
import { EMPLOYEE_AVAILABILITY } from '../../features/enterprise/vocabulary';

interface Props { employee: SiliconEmployee }

/** Stable color and expression identify each companion; real status controls its work pose. */
export function EmployeePortrait({ employee }: Props): React.JSX.Element {
  const appearance = employeeAppearance(employee.id);
  const pose = employee.availability;
  return <span className="employee-portrait" role="img"
    aria-label={`${employee.name}，${EMPLOYEE_AVAILABILITY[pose].label}数字员工形象`}
    data-character="soft-digital-companion" data-pose={pose}
    data-appearance={`${appearance.shell}-${appearance.visor}-${appearance.ear}-${appearance.core}-${appearance.palette}-${appearance.expression}`}
    data-palette={appearance.palette} data-expression={appearance.expression}
    data-shell={appearance.shell} data-visor={appearance.visor} data-ear={appearance.ear} data-core={appearance.core}>
    <span className={`employee-portrait-model employee-portrait-pose-${pose}`} aria-hidden="true">
      <span className="employee-portrait-body"><span className="employee-portrait-core" /><span className="employee-portrait-signature">SEP·AI</span></span>
      <span className="employee-portrait-arm employee-portrait-arm-left" />
      <span className="employee-portrait-arm employee-portrait-arm-right" />
      <span className="employee-portrait-head">
        <span className="employee-portrait-ear employee-portrait-ear-left" /><span className="employee-portrait-ear employee-portrait-ear-right" />
        <span className="employee-portrait-visor"><span className="employee-portrait-eye" /><span className="employee-portrait-eye" /><span className="employee-portrait-mouth" /></span>
      </span>
      {pose === 'working' ? <span className="employee-portrait-laptop" /> : null}
      {pose === 'needs-auth' ? <span className="employee-portrait-document" /> : null}
    </span>
  </span>;
}
