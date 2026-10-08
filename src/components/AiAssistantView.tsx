import React, { useState } from 'react';
import { Product, Transaction } from '../types';
import { apiPost, ApiError } from '../services/dyposApi';
import { Bot, Sparkles, Send, Loader2, ArrowRight, CheckCircle } from 'lucide-react';

interface AiAssistantViewProps {
  products: Product[];
  transactions: Transaction[];
}

export const AiAssistantView: React.FC<AiAssistantViewProps> = ({ products, transactions }) => {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    {
      role: 'assistant',
      content: 'أهلاً بك يا فندم! أنا مساعد Gemini الذكي لنظام التجارة الذكية. يمكنني تحليل مستويات المخزون، التنبؤ بالمنتجات الأكثر طلباً، تقديم استراتيجيات تسعير، أو الإجابة على أي استفسارات مالية. كيف يمكنني مساعدتك اليوم؟',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSend = async (customPrompt?: string) => {
    const promptToSend = customPrompt || input;
    if (!promptToSend.trim() || isLoading) return;

    const userMessage = { role: 'user' as const, content: promptToSend };
    setMessages((prev) => [...prev, userMessage]);
    if (!customPrompt) setInput('');
    setIsLoading(true);

    try {
      const storeContext = {
        productsCount: products.length,
        lowStockProducts: products.filter((p) => p.stock <= p.minStock).map((p) => p.name),
        totalTransactions: transactions.length,
        totalRevenue: transactions.reduce((sum, t) => sum + t.total, 0),
      };

      // Via `apiPost`: the raw fetch sent no tenant header and no session token,
      // so the assistant endpoint had to guess whose data it was being asked
      // about. It now receives a signed identity it can trust.
      const data = await apiPost<{ result?: string; error?: string }>('/api/ai-assistant', {
        prompt: promptToSend,
        context: storeContext,
      });

      if (data.result) {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: data.result ?? '',
        }]);
      } else {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: data.error || 'عذراً، حدث خطأ أثناء معالجة الطلب.',
        }]);
      }
    } catch (err) {
      // Say the truth: the request failed. The previous text ("حدث خطأ في
      // الاتصال بالخادم") was also shown for a 500 or a 403, so a permission
      // problem was reported to the operator as a network problem.
      console.error(err);
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: err instanceof ApiError
          ? `تعذّر تنفيذ الطلب: ${err.message}`
          : 'تعذّر الاتصال بالخادم — تحقق من الشبكة.',
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const quickPrompts = [
    'تحليل حالة المخزون الحالي وتقديم توصيات إعادة الطلب',
    'ما هي المنتجات الأكثر مبيعاً وكيف نحسن أرباحها؟',
    'اقتراح استراتيجية تسويقية لزيادة مبيعات الأسبوع القادم',
    'ملخص سريع للأداء المالي والإيرادات الحالية',
  ];

  return (
    <div className="flex-1 flex flex-col p-6 overflow-hidden bg-canvas text-ink">
      <div className="mb-4">
        <h2 className="text-xl font-black text-white flex items-center gap-2">
          <Bot className="w-6 h-6 text-brand-400" />
          مساعد الذكاء الاصطناعي Gemini (مستشار الأعمال والتحليلات)
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">تحليل ذكي متقدم لبيانات المخزون والمبيعات لدعم اتخاذ القرار المؤسسي</p>
      </div>

      {/* Quick Suggestions */}
      <div className="flex items-center gap-2 overflow-x-auto pb-3 mb-4 scrollbar-thin">
        {quickPrompts.map((qp, idx) => (
          <button
            key={idx}
            onClick={() => handleSend(qp)}
            className="bg-slate-900 border border-slate-800 hover:border-brand-500/50 text-slate-300 hover:text-white px-3.5 py-2 rounded-xl text-xs whitespace-nowrap transition-all flex items-center gap-1.5 shadow-sm"
          >
            <Sparkles className="w-3.5 h-3.5 text-brand-400" />
            {qp}
          </button>
        ))}
      </div>

      {/* Chat Box */}
      <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl p-4 overflow-y-auto space-y-4 shadow-sm mb-4">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
          >
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                msg.role === 'user'
                  ? 'bg-brand-600 text-white font-bold text-xs'
                  : 'bg-gradient-to-tr from-brand-600 to-teal-500 text-white shadow-md shadow-brand-600/20'
              }`}
            >
              {msg.role === 'user' ? 'أنت' : <Bot className="w-5 h-5" />}
            </div>
            <div
              className={`max-w-[80%] rounded-2xl p-4 text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-brand-600 text-white rounded-tl-none font-medium'
                  : 'bg-slate-950 border border-slate-800 text-slate-200 rounded-tr-none'
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-brand-600/20 text-brand-400 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 text-xs text-slate-400">
              جاري تحليل بيانات النظام وصياغة التوصية الاستراتيجية بواسطة Gemini...
            </div>
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-2 flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="اسأل مساعد Gemini أي استفسار حول المخزون أو المبيعات أو استراتيجيات التسعير..."
          className="flex-1 bg-transparent px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none"
        />
        <button
          onClick={() => handleSend()}
          disabled={isLoading || !input.trim()}
          className="bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg shadow-brand-600/30"
        >
          <span>إرسال</span>
          <Send className="w-4 h-4 rtl:rotate-180" />
        </button>
      </div>
    </div>
  );
};
