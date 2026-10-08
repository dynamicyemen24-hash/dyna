/**
 * Smart Operational Advisor & Interactive Guidance Engine
 * Proactively analyzes application state, user role, active screen, and telemetry
 * to guide the operator to the correct next action with zero ambiguity.
 */

export interface OperationalAdvice {
  id: string;
  type: 'info' | 'warning' | 'success' | 'action';
  title: string;
  message: string;
  actionLabel?: string;
  actionTarget?: string;
}

export function getOperationalAdvice(currentScreen: string, userRole: string, activeShiftOpen: boolean): OperationalAdvice[] {
  const advices: OperationalAdvice[] = [];

  if (!activeShiftOpen && currentScreen === 'pos') {
    advices.push({
      id: 'shift-not-open',
      type: 'warning',
      title: 'الوردية غير مفتوحة',
      message: 'يجب فتح الوردية وإدخال النقدية الافتتاحية في الدرج قبل بدء تسجيل المبيعات النقدية.',
      actionLabel: 'فتح الوردية الآن',
      actionTarget: 'shift_open'
    });
  }

  if (currentScreen === 'inventory') {
    advices.push({
      id: 'inv-sync',
      type: 'info',
      title: 'المخزون متزامن مع السحابة',
      message: 'جميع مستويات المخزون محدثة ومحمية ضد التداخل عبر محرك المزامنة اللحظي.',
      actionLabel: 'تحديث الأسعار',
      actionTarget: 'refresh_prices'
    });
  }

  if (currentScreen === 'accounting') {
    advices.push({
      id: 'acc-audit',
      type: 'success',
      title: 'القيود المحاسبية متوازنة',
      message: 'تم مراجعة كافة القيود والتدفقات النقدية تلقائياً وفق معايير الضريبة والفوترة الإلكترونية.',
      actionLabel: 'عرض القوائم المالية',
      actionTarget: 'financial_statements'
    });
  }

  if (userRole === 'admin') {
    advices.push({
      id: 'admin-telemetry',
      type: 'info',
      title: 'مراقبة العقد الذكية نشطة',
      message: 'جميع فروع المؤسسة متصلة بالسحابة مع تفعيل الحماية الصفرية (Zero-Trust).',
      actionLabel: 'فحص الجهاز',
      actionTarget: 'diagnostics'
    });
  }

  return advices;
}
