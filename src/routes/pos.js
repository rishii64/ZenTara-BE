const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// POST /api/pos/checkout - Complete sale, generate unique invoice, deduct stock atomically
// Roles: Cashier, Admin, Store Manager
router.post('/checkout', authenticateToken, requireRole('Cashier', 'Store Manager', 'Admin'), async (req, res) => {
  const {
    customer_name = 'Walk-in Customer',
    customer_phone,
    items,
    discount_amount = 0,
    discount_percentage = 0,
    discount_approved_by,
    payment_method,
    cash_tendered = 0,
    payment_details
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty. Add items to checkout.' });
  }

  const validPaymentMethods = ['Cash', 'UPI', 'Card', 'Split'];
  if (!payment_method || !validPaymentMethods.includes(payment_method)) {
    return res.status(400).json({ error: `Payment method must be one of: ${validPaymentMethods.join(', ')}` });
  }

  try {
    // Pre-validate all cart items against live database stock
    const validatedItems = [];
    let calculatedSubtotal = 0;
    let calculatedGstTotal = 0;

    for (const item of items) {
      if (!item.variant_id || !item.quantity || Number(item.quantity) <= 0) {
        return res.status(400).json({ error: 'Invalid item data in cart.' });
      }

      const qty = parseInt(item.quantity, 10);

      const variant = await db.queryOne(`
        SELECT 
          v.*,
          p.name as product_name,
          p.hsn_code,
          p.gst_rate
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        WHERE v.id = ?
      `, [item.variant_id]);

      if (!variant) {
        return res.status(404).json({ error: `Product variant with ID ${item.variant_id} does not exist.` });
      }

      // Strict Rule: Do not allow a sale quantity greater than available saleable stock
      if (Number(variant.saleable_stock) < qty) {
        return res.status(400).json({
          error: `Insufficient stock for "${variant.product_name} (${variant.size}, ${variant.colour})". Available: ${variant.saleable_stock}, Requested: ${qty}`
        });
      }

      const unitPrice = Number(variant.selling_price);
      const lineDiscount = Number(item.discount_amount) || 0;
      const itemSubtotal = (unitPrice * qty) - lineDiscount;

      // Calculate GST
      const gstRate = Number(variant.gst_rate) || 5.0;
      const taxableValue = itemSubtotal / (1 + (gstRate / 100));
      const gstValue = itemSubtotal - taxableValue;

      calculatedSubtotal += itemSubtotal;
      calculatedGstTotal += gstValue;

      validatedItems.push({
        variant,
        quantity: qty,
        unit_price: unitPrice,
        discount_amount: lineDiscount,
        gst_rate: gstRate,
        gst_amount: gstValue,
        taxable_amount: taxableValue,
        line_total: itemSubtotal
      });
    }

    // Calculate bill-level discount
    const finalDiscount = Number(discount_amount) || 0;
    if (finalDiscount > 0 && req.user.role === 'Cashier' && !discount_approved_by) {
      const discountPct = (finalDiscount / calculatedSubtotal) * 100;
      if (discountPct > 5) {
        return res.status(403).json({
          error: `Discounts exceeding 5% require Store Manager approval. Current discount: ${discountPct.toFixed(1)}%`
        });
      }
    }

    const finalTotal = Math.max(0, calculatedSubtotal - finalDiscount);
    const roundedAmount = Math.round(finalTotal);
    const totalTaxable = Math.max(0, calculatedSubtotal - calculatedGstTotal - (finalDiscount / 1.05));
    const finalGstAmount = finalTotal - totalTaxable;
    const halfGst = +(finalGstAmount / 2).toFixed(2); // CGST and SGST

    // Check cash tendered if cash payment
    const cashGiven = Number(cash_tendered) || 0;
    let changeReturned = 0;
    if (payment_method === 'Cash') {
      if (cashGiven < roundedAmount) {
        return res.status(400).json({
          error: `Cash tendered (₹${cashGiven}) is less than total amount (₹${roundedAmount}).`
        });
      }
      changeReturned = cashGiven - roundedAmount;
    }

    // Generate unique invoice number: INV-YYYYMMDD-XXXX
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const countRow = await db.queryOne("SELECT COUNT(*) as count FROM sales WHERE invoice_number LIKE ?", [`INV-${todayStr}-%`]);
    const invoiceCount = parseInt(countRow?.count || 0, 10);
    const invoiceNumber = `INV-${todayStr}-${String(invoiceCount + 1).padStart(4, '0')}`;

    // Execute database transaction atomically
    const checkoutResult = await db.transaction(async (tx) => {
      const saleResult = await tx.execute(`
        INSERT INTO sales (
          invoice_number, customer_name, customer_phone, subtotal, discount_amount, discount_percentage,
          discount_approved_by, taxable_amount, gst_amount, cgst_amount, sgst_amount, total_amount, rounded_amount,
          cashier_id, payment_method, cash_tendered, change_returned, payment_details, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
      `, [
        invoiceNumber,
        customer_name ? customer_name.trim() : 'Walk-in Customer',
        customer_phone ? customer_phone.trim() : null,
        calculatedSubtotal,
        finalDiscount,
        Number(discount_percentage) || 0,
        discount_approved_by || null,
        totalTaxable,
        finalGstAmount,
        halfGst,
        halfGst,
        finalTotal,
        roundedAmount,
        req.user.id,
        payment_method,
        cashGiven,
        changeReturned,
        payment_details ? JSON.stringify(payment_details) : null
      ]);
      const saleId = saleResult.lastInsertRowid;

      for (const item of validatedItems) {
        await tx.execute(`
          INSERT INTO sale_items (
            sale_id, variant_id, product_name, size, colour, sku, hsn_code,
            unit_price, quantity, discount_amount, gst_rate, gst_amount, line_total, returned_quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `, [
          saleId,
          item.variant.id,
          item.variant.product_name,
          item.variant.size,
          item.variant.colour,
          item.variant.sku,
          item.variant.hsn_code,
          item.unit_price,
          item.quantity,
          item.discount_amount,
          item.gst_rate,
          item.gst_amount,
          item.line_total
        ]);

        // Decrement saleable stock
        await tx.execute(`
          UPDATE product_variants
          SET saleable_stock = saleable_stock - ?
          WHERE id = ?
        `, [item.quantity, item.variant.id]);

        // Log in Stock Ledger audit trail
        await tx.execute(`
          INSERT INTO stock_ledger (
            variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
          ) VALUES (?, 'POS_SALE', ?, ?, 'saleable', ?, ?, ?, ?)
        `, [
          item.variant.id,
          invoiceNumber,
          -item.quantity,
          item.variant.saleable_stock,
          Number(item.variant.saleable_stock) - item.quantity,
          req.user.id,
          `POS Invoice: ${invoiceNumber}`
        ]);
      }

      const sale = await tx.queryOne('SELECT * FROM sales WHERE id = ?', [saleId]);
      const saleItems = await tx.query('SELECT * FROM sale_items WHERE sale_id = ?', [saleId]);
      const cashier = await tx.queryOne('SELECT full_name, role FROM users WHERE id = ?', [sale.cashier_id]);
      const settingsRows = await tx.query('SELECT key, value FROM store_settings');
      const settings = {};
      settingsRows.forEach(r => settings[r.key] = r.value);

      return {
        sale: {
          ...sale,
          items: saleItems,
          cashier_name: cashier?.full_name || 'Cashier'
        },
        store: settings
      };
    });

    res.status(201).json(checkoutResult);
  } catch (err) {
    console.error('Error in POS checkout:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
