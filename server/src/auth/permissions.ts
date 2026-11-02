// One place that defines what each account type may do. The API checks these on every action;
// the database's row-level security separately guarantees tenant isolation.
export type AccountRole = 'admin' | 'analyst' | 'customer';

export const PERMISSIONS = {
  viewAllTenants: ['admin', 'analyst'],
  staffEscalationActions: ['admin', 'analyst'],      // escalate, remind, verify and close
  customerEscalationActions: ['customer'],           // acknowledge, start remediation, request closure
  postMessage: ['admin', 'analyst', 'customer'],
  uploadReports: ['admin'],
  withdrawReports: ['admin'],
  downloadReports: ['admin', 'analyst', 'customer'],
  raiseRequest: ['customer'],
  updateRequest: ['admin', 'analyst'],
  editContacts: ['admin', 'customer'],
  confirmContacts: ['customer'],
  remindContacts: ['admin', 'analyst'],
  viewHealth: ['admin', 'analyst'],
  viewAudit: ['admin', 'analyst', 'customer'],
  viewIntegrations: ['admin', 'analyst'],
  editIntegrations: ['admin'],
  manageUsers: ['admin'],
  editSla: ['admin'],
  manageTenants: ['admin'],
} as const satisfies Record<string, readonly AccountRole[]>;

export type Permission = keyof typeof PERMISSIONS;
export const can = (role: AccountRole, p: Permission) => (PERMISSIONS[p] as readonly string[]).includes(role);

// Shown on the Administration page so the matrix always matches the code.
export const PERMISSION_TABLE: { capability: string; admin: string; analyst: string; customer: string }[] = [
  { capability: 'View tenants', admin: 'All tenants', analyst: 'All tenants', customer: 'Own tenant only' },
  { capability: 'Escalation status updates', admin: 'Yes', analyst: 'Yes', customer: 'Acknowledge and remediation steps' },
  { capability: 'Escalation messages', admin: 'Yes', analyst: 'Yes', customer: 'Own escalations' },
  { capability: 'Security dashboard and scorecard', admin: 'All tenants', analyst: 'All tenants', customer: 'Own tenant' },
  { capability: 'Upload and withdraw reports', admin: 'Yes', analyst: 'No', customer: 'No' },
  { capability: 'Download reports', admin: 'Yes', analyst: 'Yes', customer: 'Own tenant' },
  { capability: 'Service requests', admin: 'Update status', analyst: 'Update status', customer: 'Raise and track' },
  { capability: 'Escalation contacts', admin: 'Edit any tenant', analyst: 'Send reminders', customer: 'Edit own' },
  { capability: 'Customer health', admin: 'Yes', analyst: 'Yes', customer: 'No' },
  { capability: 'Audit log', admin: 'All activity', analyst: 'All activity', customer: 'Own tenant' },
  { capability: 'API configuration', admin: 'Edit', analyst: 'View only', customer: 'No access' },
  { capability: 'User accounts and SLA targets', admin: 'Manage', analyst: 'No', customer: 'No' },
];
