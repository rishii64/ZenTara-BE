const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/returns - list returns
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, type, limit = 100 } = req.query;

    let query = `
      SELECT 
        r.*,
        s.invoice_number as original_invoice,
        s.customer_name,
        s.customer_phone,
        u.full_name as processed_by_name,
        mu.full_name as approved_by_name,
        COUNT(ri.id) as item_count
      FROM returns r
      JOIN sales s ON s.id = r.original_sale_id
      JOIN users u ON u.id = r.processed_by_id
      LEFT JOIN users mu ON mu.id = r.manager_approved_by_id
      LEFT JOIN return_items ri ON ri.return_id = r.id
      WHERE 1=1
    `;
    const params = [];

    if (type) {
      query += ` AND r.type = ?`;
      params.push(type);
    }
    if (from_date) {
      query += ` AND r.created_at::date >= ?::date`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND r.created_at::date <= ?::date`;
      params.push(to_date);
    }

    query += ` GROUP BY r.id, s.invoice_number, s.customer_name, s.customer_phone, u.full_name, mu.full_name ORDER BY r.id DESC LIMIT ?`;
    params.push(Number(limit) || 100);

    const returns = await db.query(query, params);
    res.json(returns);
  } catch (err) {
    console.error('Error fetching returns:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/returns/verify-invoice/:invoiceNumber - lookup original invoice for return eligibility
router.get('/verify-invoice/:invoiceNumber', authenticateToken, async (req, res) => {
  try {
    const invoiceNumber = req.params.invoiceNumber.trim();
    const sale = await db.queryOne(`
      SELECT s.*, u.full_name as cashier_name
      FROM sales s
      JOIN users u ON u.id = s.cashier_id
      WHERE s.invoice_number = ?
    `, [invoiceNumber]);

    if (!sale) {
      return res.status(404).json({ error: `Invoice "${invoiceNumber}" not found.` });
    }

    if (sale.status === 'cancelled') {
      return res.status(400).json({ error: 'This invoice was cancelled/voided. Cannot process return.' });
    }

    const items = await db.query(`
      SELECT 
        si.*,
        v.sku,
        v.barcode,
        v.saleable_stock as current_saleable_stock,
        (si.quantity - si.returned_quantity) as eligible_quantity
      FROM sale_items si
      JOIN product_variants v ON v.id = si.variant_id
      WHERE si.sale_id = ?
    `, [sale.id]);

    res.json({
      sale,
      items
    });
  } catch (err) {
    console.error('Error verifying invoice for return:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/returns/:id - get single return details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const ret = await db.queryOne(`
      SELECT 
        r.*,
        s.invoice_number as original_invoice,
        s.customer_name,
        s.customer_phone,
        u.full_name as processed_by_name,
        mu.full_name as approved_by_name
      FROM returns r
      JOIN sales s ON s.id = r.original_sale_id
      JOIN users u ON u.id = r.processed_by_id
      LEFT JOIN users mu ON mu.id = r.manager_approved_by_id
      WHERE r.id = ?
    `, [req.params.id]);

    if (!ret) return res.status(404).json({ error: 'Return record not found.' });

    const items = await db.query(`
      SELECT 
        ri.*,
        si.product_name,
        si.size,
        si.colour,
        si.sku,
        si.hsn_code
      FROM return_items ri
      JOIN sale_items si ON si.id = ri.sale_item_id
      WHERE ri.return_id = ?
    `, [ret.id]);

    let replacementSale = null;
    if (ret.replacement_sale_id) {
      replacementSale = await db.queryOne('SELECT * FROM sales WHERE id = ?', [ret.replacement_sale_id]);
    }

    res.json({
      ...ret,
      items,
      replacementSale
    });
  } catch (err) {
    console.error('Error fetching return details:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/returns - Process Return or Exchange
// Authorized roles: Cashier, Store Manager, Admin
router.post('/', authenticateToken, requireRole('Cashier', 'Store Manager', 'Admin'), async (req, res) => {
  const {
    original_invoice_number,
    type = 'refund', // 'refund' or 'exchange'
    items, // [{ sale_item_id, quantity, condition: 'saleable'|'damaged', reason }]
    refund_method = 'Cash',
    notes,
    manager_approved_by_id,
    exchange_items // [{ variant_id, quantity }]
  } = req.body;

  if (!original_invoice_number) {
    return res.status(400).json({ error: 'Original invoice number is required.' });
  }

  const validTypes = ['refund', 'exchange'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Return type must be refund or exchange.' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item must be selected for return.' });
  }

  try {
    const sale = await db.queryOne('SELECT * FROM sales WHERE invoice_number = ?', [original_invoice_number.trim()]);
    if (!sale) {
      return res.status(404).json({ error: `Invoice ${original_invoice_number} not found.` });
    }

    if (sale.status === 'cancelled') {
      return res.status(400).json({ error: 'Invoice has been cancelled. Cannot return.' });
    }

    // Generate return number: RET-YYYYMMDD-XXXX
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const countRow = await db.queryOne("SELECT COUNT(*) as count FROM returns WHERE return_number LIKE ?", [`RET-${todayStr}-%`]);
    const returnCount = parseInt(countRow?.count || 0, 10);
    const returnNumber = `RET-${todayStr}-${String(returnCount + 1).padStart(4, '0')}`;

    let totalReturnAmount = 0;
    const validatedReturnItems = [];

    for (const item of items) {
      const saleItem = await db.queryOne('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?', [item.sale_item_id, sale.id]);
      if (!saleItem) {
        return res.status(404).json({ error: `Sale line item ID ${item.sale_item_id} not found on this invoice.` });
      }

      const returnQty = parseInt(item.quantity, 10);
      const eligibleQty = Number(saleItem.quantity) - Number(saleItem.returned_quantity);

      if (returnQty <= 0) {
        return res.status(400).json({ error: 'Return quantity must be greater than zero.' });
      }
      if (returnQty > eligibleQty) {
        return res.status(400).json({
          error: `Cannot return ${returnQty} units of "${saleItem.product_name}". Eligible units left: ${eligibleQty}.`
        });
      }

      const validConditions = ['saleable', 'damaged'];
      const condition = item.condition || 'saleable';
      if (!validConditions.includes(condition)) {
        return res.status(400).json({ error: 'Item condition must be saleable or damaged.' });
      }

      const unitPrice = Number(saleItem.unit_price);
      const itemRefund = unitPrice * returnQty;
      totalReturnAmount += itemRefund;

      validatedReturnItems.push({
        saleItem,
        returnQty,
        condition,
        reason: item.reason || 'Customer Return',
        unitPrice,
        refundAmount: itemRefund
      });
    }

    // If Exchange: Validate replacement items
    let replacementTotal = 0;
    const validatedExchangeItems = [];

    if (type === 'exchange') {
      if (!exchange_items || !Array.isArray(exchange_items) || exchange_items.length === 0) {
        return res.status(400).json({ error: 'Exchange requires at least one replacement item.' });
      }

      for (const ex of exchange_items) {
        const exQty = parseInt(ex.quantity, 10);
        if (exQty <= 0) return res.status(400).json({ error: 'Replacement quantity must be > 0.' });

        const exVariant = await db.queryOne(`
          SELECT v.*, p.name as product_name, p.hsn_code, p.gst_rate
          FROM product_variants v
          JOIN products p ON p.id = v.product_id
          WHERE v.id = ?
        `, [ex.variant_id]);

        if (!exVariant) return res.status(404).json({ error: `Replacement variant ID ${ex.variant_id} not found.` });

        if (Number(exVariant.saleable_stock) < exQty) {
          return res.status(400).json({
            error: `Insufficient stock for replacement "${exVariant.product_name} (${exVariant.size})". Available: ${exVariant.saleable_stock}, Requested: ${exQty}`
          });
        }

        const exPrice = Number(exVariant.selling_price);
        const exLineTotal = exPrice * exQty;
        replacementTotal += exLineTotal;

        validatedExchangeItems.push({
          variant: exVariant,
          quantity: exQty,
          unit_price: exPrice,
          line_total: exLineTotal
        });
      }
    }

    const netDifference = +(replacementTotal - totalReturnAmount).toFixed(2);

    const transactionResult = await db.transaction(async (tx) => {
      // 1. Insert Return record
      const insertReturnRes = await tx.execute(`
        INSERT INTO returns (
          return_number, original_sale_id, type, processed_by_id, manager_approved_by_id,
          total_return_amount, net_difference, refund_method, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        returnNumber,
        sale.id,
        type,
        req.user.id,
        manager_approved_by_id || (req.user.role === 'Store Manager' || req.user.role === 'Admin' ? req.user.id : null),
        totalReturnAmount,
        netDifference,
        refund_method,
        notes ? notes.trim() : null
      ]);
      const returnId = insertReturnRes.lastInsertRowid;

      for (const vItem of validatedReturnItems) {
        await tx.execute(`
          INSERT INTO return_items (
            return_id, sale_item_id, variant_id, quantity, unit_price, refund_amount, condition, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          returnId,
          vItem.saleItem.id,
          vItem.saleItem.variant_id,
          vItem.returnQty,
          vItem.unitPrice,
          vItem.refundAmount,
          vItem.condition,
          vItem.reason
        ]);

        await tx.execute(`
          UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?
        `, [vItem.returnQty, vItem.saleItem.id]);

        const variant = await tx.queryOne(
          'SELECT saleable_stock, damaged_stock FROM product_variants WHERE id = ?',
          [vItem.saleItem.variant_id]
        );

        if (vItem.condition === 'saleable') {
          await tx.execute(
            'UPDATE product_variants SET saleable_stock = saleable_stock + ? WHERE id = ?',
            [vItem.returnQty, vItem.saleItem.variant_id]
          );

          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, 'CUSTOMER_RETURN_SALEABLE', ?, ?, 'saleable', ?, ?, ?, ?)
          `, [
            vItem.saleItem.variant_id,
            returnNumber,
            vItem.returnQty,
            variant.saleable_stock,
            Number(variant.saleable_stock) + vItem.returnQty,
            req.user.id,
            `Return: ${returnNumber} | Reason: ${vItem.reason}`
          ]);
        } else {
          await tx.execute(
            'UPDATE product_variants SET damaged_stock = damaged_stock + ? WHERE id = ?',
            [vItem.returnQty, vItem.saleItem.variant_id]
          );

          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, 'CUSTOMER_RETURN_DAMAGED', ?, ?, 'damaged', ?, ?, ?, ?)
          `, [
            vItem.saleItem.variant_id,
            returnNumber,
            vItem.returnQty,
            variant.damaged_stock,
            Number(variant.damaged_stock) + vItem.returnQty,
            req.user.id,
            `Return Damaged: ${returnNumber} | Reason: ${vItem.reason}`
          ]);
        }
      }

      // 3. If exchange, create replacement sale & deduct replacement stock
      if (type === 'exchange') {
        const exCountRow = await tx.queryOne("SELECT COUNT(*) as count FROM sales WHERE invoice_number LIKE ?", [`INV-${todayStr}-%`]);
        const exInvoiceCount = parseInt(exCountRow?.count || 0, 10);
        const exInvoiceNumber = `INV-${todayStr}-${String(exInvoiceCount + 1).padStart(4, '0')}`;

        const exTaxable = replacementTotal / 1.05;
        const exGst = replacementTotal - exTaxable;
        const exHalfGst = +(exGst / 2).toFixed(2);

        const insertExSaleRes = await tx.execute(`
          INSERT INTO sales (
            invoice_number, customer_name, customer_phone, subtotal, discount_amount, discount_percentage,
            taxable_amount, gst_amount, cgst_amount, sgst_amount, total_amount, rounded_amount,
            cashier_id, payment_method, status
          ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 'Exchange', 'completed')
        `, [
          exInvoiceNumber,
          sale.customer_name,
          sale.customer_phone,
          replacementTotal,
          exTaxable,
          exGst,
          exHalfGst,
          exHalfGst,
          replacementTotal,
          Math.round(replacementTotal),
          req.user.id
        ]);
        const replacementSaleId = insertExSaleRes.lastInsertRowid;

        await tx.execute('UPDATE returns SET replacement_sale_id = ? WHERE id = ?', [replacementSaleId, returnId]);

        for (const exItem of validatedExchangeItems) {
          const itemTax = exItem.line_total - (exItem.line_total / (1 + (exItem.variant.gst_rate / 100)));
          await tx.execute(`
            INSERT INTO sale_items (
              sale_id, variant_id, product_name, size, colour, sku, hsn_code,
              unit_price, quantity, discount_amount, gst_rate, gst_amount, line_total, returned_quantity
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)
          `, [
            replacementSaleId,
            exItem.variant.id,
            exItem.variant.product_name,
            exItem.variant.size,
            exItem.variant.colour,
            exItem.variant.sku,
            exItem.variant.hsn_code,
            exItem.unit_price,
            exItem.quantity,
            exItem.variant.gst_rate,
            itemTax,
            exItem.line_total
          ]);

          await tx.execute(
            'UPDATE product_variants SET saleable_stock = saleable_stock - ? WHERE id = ?',
            [exItem.quantity, exItem.variant.id]
          );

          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, 'POS_SALE_EXCHANGE', ?, ?, 'saleable', ?, ?, ?, ?)
          `, [
            exItem.variant.id,
            exInvoiceNumber,
            -exItem.quantity,
            exItem.variant.saleable_stock,
            Number(exItem.variant.saleable_stock) - exItem.quantity,
            req.user.id,
            `Exchange Replacement for Return: ${returnNumber}`
          ]);
        }
      }

      const createdReturn = await tx.queryOne('SELECT * FROM returns WHERE id = ?', [returnId]);
      const returnItemsList = await tx.query('SELECT * FROM return_items WHERE return_id = ?', [returnId]);

      return {
        ...createdReturn,
        items: returnItemsList
      };
    });

    res.status(201).json({
      message: `${type === 'exchange' ? 'Exchange' : 'Return'} processed successfully.`,
      return: transactionResult
    });
  } catch (err) {
    console.error('Error processing return:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
