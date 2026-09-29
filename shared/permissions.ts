export const ROLES = ['admin', 'manager', 'staff', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
  viewer: 'View only',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  admin: 'Everything, including users, settings and data export.',
  manager: 'Runs the day: orders, products, exceptions, reports and approvals.',
  staff: 'Orders, cutting, packing and fulfilment.',
  viewer: 'Can look at everything operational, but cannot change anything.',
};

export type Permission =
  | 'orders.read'
  | 'orders.write'
  | 'orders.cancel'
  | 'orders.reopen'
  | 'production.write'
  | 'import.run'
  | 'exceptions.resolve'
  | 'customers.read'
  | 'customers.write'
  | 'customers.delete'
  | 'products.read'
  | 'products.write'
  | 'intelligence.read'
  | 'intelligence.approve'
  | 'reports.read'
  | 'stock.read'
  | 'stock.write'
  | 'stock.costs'
  | 'payments.write'
  | 'settings.read'
  | 'settings.write'
  | 'users.manage'
  | 'data.export'
  | 'system.health';

const STAFF: Permission[] = [
  'orders.read',
  'orders.write',
  'production.write',
  'import.run',
  'exceptions.resolve',
  'customers.read',
  'customers.write',
  'products.read',
  'reports.read',
  'stock.read',
  'stock.write',
];

const MANAGER: Permission[] = [
  ...STAFF,
  'orders.cancel',
  'orders.reopen',
  'customers.delete',
  'stock.costs',
  'products.write',
  'intelligence.read',
  'intelligence.approve',
  'payments.write',
  'settings.read',
  'system.health',
];

const ADMIN: Permission[] = [...MANAGER, 'settings.write', 'users.manage', 'data.export'];

const VIEWER: Permission[] = ['orders.read', 'customers.read', 'products.read', 'reports.read', 'intelligence.read', 'stock.read'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ADMIN,
  manager: MANAGER,
  staff: STAFF,
  viewer: VIEWER,
};

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
