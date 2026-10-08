export interface Product {
  id: string;
  name: string;
  barcode: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
  minStock: number;
  image?: string;
  unit: string;
  branchId: string;
  bomItems?: { componentId: string; quantity: number }[]; // For Manufacturing BOM
}

export interface Category {
  id: string;
  name: string;
  icon: string;
}

/**
 * Sync state shown on the status bar.
 *
 * Declared here rather than in `services/backupService` because the status bar
 * only needs the union — importing the service for a type pulled the whole
 * Firebase SDK onto the application shell.
 */
export type SyncStatus = 'synced' | 'syncing' | 'offline';

export interface CartItem {
  product: Product;
  quantity: number;
  discount: number;
}

export interface Transaction {
  id: string;
  invoiceNumber: string;
  items: CartItem[];
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  paymentMethod: 'cash' | 'card' | 'mada' | 'apple_pay' | 'credit';
  customerName?: string;
  cashierName: string;
  timestamp: string;
  branchId: string;
  status: 'completed' | 'refunded' | 'held' | 'pending_sync';
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  points: number;
  balance: number;
  totalSpent: number;
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  category: string;
  balanceDue: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  items: { productName: string; quantity: number; unitCost: number }[];
  totalAmount: number;
  status: 'draft' | 'approved' | 'received' | 'cancelled';
  orderDate: string;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  date: string;
  description: string;
  accountDebit: string;
  accountCredit: string;
  amount: number;
  status: 'posted' | 'draft';
}

export interface Employee {
  id: string;
  name: string;
  role: string;
  branchId: string;
  baseSalary: number;
  commissionRate: number;
  status: 'active' | 'on_leave';
  attendanceToday: 'present' | 'absent' | 'late';
}

export interface Branch {
  id: string;
  name: string;
  city: string;
  phone: string;
  address: string;
  manager: string;
}

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  rateToSAR: number; // 1 Foreign Unit = rateToSAR in SAR
  isBase?: boolean;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: string;
  category: 'critical' | 'warning' | 'info';
  user: string;
  branch: string;
  details: string;
  previousValue?: string;
  newValue?: string;
}

export interface ShiftInfo {
  isOpen: boolean;
  cashierName: string;
  startTime: string;
  openingCash: number;
  totalSales: number;
  cashSales: number;
  cardSales: number;
  transactionsCount: number;
}
