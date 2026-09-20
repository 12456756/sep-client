import type { Subscription, EmployeeStatus, EmployeeSkillsResponse } from '../../src/shared/types'

export const SEP_TEST_SUBSCRIPTION: Subscription = {
  id: 'row-1', subscriptionId: 'sub-1', employeeId: 'employee-1', name: '??????',
  description: '??????', position: '?????', functionalCategory: '??', status: 'ACTIVE',
  templateVersion: '1.0.0', template: { id: 'employee-1', name: '??????', avatar: null },
  department: null, allowedModels: ['sep-employee'], upgradeAvailable: false,
}

export const SEP_TEST_EMPLOYEE = {
  employeeId: SEP_TEST_SUBSCRIPTION.employeeId, status: 'WORKING',
} satisfies EmployeeStatus

export const SEP_TEST_SKILLS: EmployeeSkillsResponse = {
  subscriptionId: SEP_TEST_SUBSCRIPTION.subscriptionId, canManage: false, skills: [{
    capability: { id: 'cap-1', name: '????', description: '??????', type: 'SKILL' },
    currentVersion: { id: 'version-1', capabilityId: 'cap-1', scope: 'PLATFORM', enterpriseId: null, version: '1.0.0', changeSummary: 'initial', status: 'PLATFORM_APPROVED', createdAt: '2026-09-11T07:00:00.000Z', updatedAt: '2026-09-11T07:00:00.000Z' },
    versions: [], upgradeAvailable: false,
  }],
}
