import React, { useState } from 'react';
import { Customer } from '../types';
import { Users, Search, Plus, Phone, Mail, Award } from 'lucide-react';
import {
  ScreenHeader,
  Pill,
  Input,
  Field,
  PrimaryButton,
  GhostButton,
  Modal,
  EmptyState,
} from './ui/Primitives';

interface CustomersViewProps {
  customers: Customer[];
  onAddCustomer: (customer: Customer) => void;
}

export const CustomersView: React.FC<CustomersViewProps> = ({ customers, onAddCustomer }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const filteredCustomers = customers.filter(
    (c) => c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.phone.includes(searchQuery)
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !phone) return;
    const newCustomer: Customer = {
      id: `cu-${Date.now()}`,
      name,
      phone,
      email: email || 'customer@dypos.sa',
      points: 0,
      balance: 0,
      totalSpent: 0,
    };
    onAddCustomer(newCustomer);
    setIsModalOpen(false);
    setName('');
    setPhone('');
    setEmail('');
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        icon={Users}
        title="إدارة العملاء وبرنامج الولاء"
        subtitle="متابعة حسابات العملاء، أرصدة الديون، ونقاط الولاء والمكافآت"
        actions={
          <PrimaryButton onClick={() => setIsModalOpen(true)}>
            <Plus className="w-4 h-4" />
            إضافة عميل جديد
          </PrimaryButton>
        }
      />

      <div className="surface-card p-4">
        <div className="relative">
          <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
          <Input
            type="text"
            placeholder="البحث باسم العميل أو رقم الجوال..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pr-10 pl-4 text-numeric"
          />
        </div>
      </div>

      {filteredCustomers.length === 0 ? (
        <EmptyState message="لا يوجد عملاء مطابقون لمعايير البحث" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCustomers.map((cus) => (
            <div key={cus.id} className="surface-card p-5 flex flex-col justify-between elev-1 transition-shadow hover:elev-2">
              <div>
                <div className="flex items-center justify-between mb-3 gap-2">
                  <h3 className="text-sm font-bold text-ink truncate">{cus.name}</h3>
                  <Pill tone="bg-brand-soft text-brand border-brand/20">
                    <span className="inline-flex items-center gap-1 text-numeric">
                      <Award className="w-3.5 h-3.5" /> {cus.points} نقطة
                    </span>
                  </Pill>
                </div>

              <div className="space-y-2 text-xs text-muted mb-4">
              <div className="flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-faint" />
              <span className="text-numeric">{cus.phone}</span>
              </div>
              <div className="flex items-center gap-2">
              <Mail className="w-3.5 h-3.5 text-faint" />
              <span>{cus.email}</span>
              </div>
              </div>
              </div>
              
              <div className="pt-3 border-t border-hairline flex items-center justify-between text-xs text-numeric">
                <div>
                  <span className="text-faint block text-[10px]">إجمالي المشتريات</span>
                  <span className="font-bold text-brand">{cus.totalSpent.toLocaleString()} ر.س</span>
                </div>
                <div className="text-left rtl:text-right">
                  <span className="text-faint block text-[10px]">رصيد الحساب (دين)</span>
                  <span className="font-bold text-warn-strong">{cus.balance.toLocaleString()} ر.س</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={isModalOpen} title="إضافة عميل جديد" onClose={() => setIsModalOpen(false)}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="اسم العميل:">
            <Input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="اسم العميل الثلاثي..."
            />
          </Field>

          <Field label="رقم الجوال:">
            <Input
              type="text"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="05xxxxxxxx..."
              inputMode="tel"
              className="text-numeric"
            />
          </Field>

          <Field label="البريد الإلكتروني:">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@example.com..."
              inputMode="email"
            />
          </Field>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-hairline">
            <GhostButton type="button" onClick={() => setIsModalOpen(false)}>
              إلغاء
            </GhostButton>
            <PrimaryButton type="submit">
              حفظ العميل
            </PrimaryButton>
          </div>
        </form>
      </Modal>
    </div>
  );
};
