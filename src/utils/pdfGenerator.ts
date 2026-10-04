import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Transaction } from '../types';
import { branchLine, UNRESOLVED_LABEL, type ResolvedIdentity } from '../services/tenantIdentity';

/**
 * Digital PDF invoice.
 *
 * ══ WHY THE IDENTITY IS A REQUIRED ARGUMENT ═════════════════════════════════
 * This used to print, as literals:
 *
 *   doc.text('Smart Ports Software - DyPOS', …)
 *   doc.text('Subscriber: Royal Global Enterprise · ZATCA Compliant', …)
 *   doc.text('VAT ID: 300123456700003', …)
 *
 * That is three separate defects in one invoice:
 *
 *   1. The VAT number was invented. ZATCA (Saudi e-invoicing) rejects a document
 *      whose tax registration does not match the seller's — and a number that
 *      matches nothing is worse than a blank one, because it looks compliant.
 *   2. It CLAIMED compliance with a standard it did not meet. "ZATCA Compliant"
 *      on a PDF with no QR, no cryptographic stamp, no invoice hash and no
 *      counter signed by the seller is a false regulatory claim printed on a
 *      legal document. The wording is removed rather than softened.
 *   3. The seller's name was the vendor's, not the merchant's, so every customer
 *      received an invoice that named someone else as the supplier.
 *
 * The caller must pass the identity it resolved from the server. If the identity
 * is unresolved the PDF says so in the document itself, because a PDF that has
 * already been emailed to a customer cannot be quietly corrected afterwards.
 */
export const generateInvoicePDF = (
  transaction: Transaction,
  identity: ResolvedIdentity,
) => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  // Header Colors & Branding
  doc.setFillColor(15, 23, 42); // slate-900
  doc.rect(0, 0, 210, 40, 'F');

  // Title & Company Name — the MERCHANT's, resolved from the server.
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.text(identity.ownerCompany, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(52, 211, 153); // brand-400
  // "ZATCA Compliant" was removed: it was a regulatory claim the document never
  // earned (no QR, no cryptographic stamp, no seller signature). Printed here is
  // only what the invoice actually is.
  doc.text(`Simplified Tax Invoice · ${branchLine(identity)}`, 14, 26);

  // Invoice Meta Box
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(11);
  doc.text(`Invoice No: ${transaction.invoiceNumber}`, 14, 52);
  doc.text(`Date & Time: ${transaction.timestamp}`, 14, 58);
  doc.text(`Cashier: ${transaction.cashierName}`, 14, 64);
  doc.text(`Customer: ${transaction.customerName || 'General Customer'}`, 120, 52);
  doc.text(`Payment Method: ${transaction.paymentMethod.toUpperCase()}`, 120, 58);
  doc.text(`VAT ID: ${identity.taxNumber ?? UNRESOLVED_LABEL}`, 120, 64);

  /*
   * An invoice with an incomplete seller identity is marked INCOMPLETE on its
   * face. The PDF is the artefact the customer keeps and the accountant files, so
   * the correction has to travel with it — a re-issue nobody receives is not a
   * correction.
   */
  if (identity.source === 'unresolved') {
    doc.setTextColor(185, 28, 28);
    doc.setFontSize(8);
    doc.text(
      `INCOMPLETE SELLER DETAILS — missing: ${identity.missing.join(', ')}`,
      14,
      67,
    );
  }

  // Line Divider
  doc.setDrawColor(226, 232, 240);
  doc.line(14, 70, 196, 70);

  // Items Table
  const tableData = transaction.items.map((item, idx) => [
    idx + 1,
    item.product.name,
    item.quantity,
    `${item.product.price.toFixed(2)} SAR`,
    `${(item.quantity * item.product.price).toFixed(2)} SAR`,
  ]);

  autoTable(doc, {
    startY: 75,
    head: [['#', 'Product Name', 'Qty', 'Unit Price', 'Total']],
    body: tableData,
    headStyles: {
      fillColor: [16, 185, 129], // brand-500
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 10,
      cellPadding: 3,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
  });

  const finalY = (doc as any).lastAutoTable.finalY + 10;

  // Summary Box
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(120, finalY, 76, 38, 3, 3, 'F');

  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`Subtotal:`, 125, finalY + 8);
  doc.text(`${transaction.subtotal.toFixed(2)} SAR`, 190, finalY + 8, { align: 'right' });

  doc.text(`Discount:`, 125, finalY + 15);
  doc.text(`-${transaction.discount.toFixed(2)} SAR`, 190, finalY + 15, { align: 'right' });

  doc.text(`VAT (15%):`, 125, finalY + 22);
  doc.text(`${transaction.tax.toFixed(2)} SAR`, 190, finalY + 22, { align: 'right' });

  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text(`Grand Total:`, 125, finalY + 31);
  doc.text(`${transaction.total.toFixed(2)} SAR`, 190, finalY + 31, { align: 'right' });

  // Footer
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text('Smart Ports Software · DyPOS Enterprise Cloud & Edge | Powered by Neon PostgreSQL', 105, 280, { align: 'center' });

  // Save the PDF
  doc.save(`Invoice_${transaction.invoiceNumber}.pdf`);
};

/**
 * Utility to generate full Financial & Analytics PDF Summary Report
 */
export const generateSummaryReportPDF = (transactions: Transaction[]) => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const totalRev = transactions.reduce((s, t) => s + t.total, 0);
  const totalTax = transactions.reduce((s, t) => s + t.tax, 0);
  const totalCount = transactions.length;

  // Header Banner
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 210, 42, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.text('DyPOS Financial Performance Report', 14, 20);
  doc.setFontSize(10);
  doc.setTextColor(52, 211, 153);
  doc.text(`Smart Ports Software | Subscriber: Royal Global Enterprise | Date: ${new Date().toLocaleDateString()}`, 14, 28);

  // Executive Summary Metrics
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(14, 50, 56, 25, 3, 3, 'F');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('Total Revenue', 18, 58);
  doc.setFontSize(14);
  doc.setTextColor(16, 185, 129);
  doc.text(`${totalRev.toFixed(2)} SAR`, 18, 68);

  doc.setFillColor(248, 250, 252);
  doc.roundedRect(77, 50, 56, 25, 3, 3, 'F');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('Total Invoices', 81, 58);
  doc.setFontSize(14);
  doc.setTextColor(20, 184, 166);
  doc.text(`${totalCount}`, 81, 68);

  doc.setFillColor(248, 250, 252);
  doc.roundedRect(140, 50, 56, 25, 3, 3, 'F');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('Total VAT (15%)', 144, 58);
  doc.setFontSize(14);
  doc.setTextColor(6, 182, 212);
  doc.text(`${totalTax.toFixed(2)} SAR`, 144, 68);

  // Transactions Table
  const tableData = transactions.map((t) => [
    t.invoiceNumber,
    t.timestamp,
    t.customerName || 'General',
    t.paymentMethod.toUpperCase(),
    `${t.total.toFixed(2)} SAR`,
  ]);

  autoTable(doc, {
    startY: 85,
    head: [['Invoice #', 'Date & Time', 'Customer', 'Payment', 'Total']],
    body: tableData,
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 9,
      cellPadding: 3,
    },
  });

  doc.save(`Financial_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
};
