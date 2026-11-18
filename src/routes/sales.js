const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/sales - List sales history
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, cashier_id, status, search, limit = 100 } = req.query;

    let query = `
      SELECT 
        s.*,
        u.full_name as cashier_name,
        cu.full_name as cancelled_by_name,
        COUNT(si.id) as item_count,
        COALESCE(SUM(si.quantity), 0) as total_units
      FROM sales s
      JOIN users u ON u.id = s.cashier_id
      LEFT JOIN users cu ON cu.id = s.cancelled_by
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND s.status = ?`;
      params.push(status);
    }
    if (cashier_id) {
      query += ` AND s.cashier_id = ?`;
      params.push(cashier_id);
    }
    if (from_date) {
      query += ` AND s.created_at::date >= ?::date`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND s.created_at::date <= ?::date`;
      params.push(to_date);
    }
    if (search) {
      query += ` AND (s.invoice_number ILIKE ? OR s.customer_name ILIKE ? OR s.customer_phone ILIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    query += ` GROUP BY s.id, u.full_name, cu.full_name ORDER BY s.id DESC LIMIT ?`;
    params.push(Number(limit) || 100);

    const sales = await db.query(query, params);
    res.json(sales);
  } catch (err) {
    console.error('Error fetching sales:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sales/:id - View invoice details for display / printing
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const idOrInvoice = req.params.id;

    let sale;
    if (/^\d+$/.test(idOrInvoice)) {
      sale = await db.queryOne(`
        SELECT s.*, u.full_name as cashier_name, cu.full_name as cancelled_by_name
        FROM sales s
        JOIN users u ON u.id = s.cashier_id
        LEFT JOIN users cu ON cu.id = s.cancelled_by
        WHERE s.id = ?
      `, [idOrInvoice]);
    } else {
      sale = await db.queryOne(`
        SELECT s.*, u.full_name as cashier_name, cu.full_name as cancelled_by_name
        FROM sales s
        JOIN users u ON u.id = s.cashier_id
        LEFT JOIN users cu ON cu.id = s.cancelled_by
        WHERE s.invoice_number = ?
      `, [idOrInvoice]);
    }

    if (!sale) return res.status(404).json({ error: 'Invoice not found.' });

    const items = await db.query(`
      SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC
    `, [sale.id]);

    const returns = await db.query(`
      SELECT r.*, u.full_name as processed_by_name
      FROM returns r
      JOIN users u ON u.id = r.processed_by_id
      WHERE r.original_sale_id = ?
    `, [sale.id]);

    const settingsRows = await db.query('SELECT key, value FROM store_settings');
    const settings = {};
    settingsRows.forEach(r => settings[r.key] = r.value);

    res.json({
      sale: {
        ...sale,
        items,
        returns
      },
      store: settings
    });
  } catch (err) {
    console.error('Error fetching sale details:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sales/:id/cancel - Void / Cancel Invoice
// Restricted to Admin and Store Manager
router.post('/:id/cancel', authenticateToken, requireRole('Admin', 'Store Manager'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'Cancellation reason is mandatory.' });
  }

  try {
    const sale = await db.queryOne('SELECT * FROM sales WHERE id = ?', [id]);
    if (!sale) return res.status(404).json({ error: 'Sale record not found.' });

    if (sale.status === 'cancelled') {
      return res.status(400).json({ error: 'Invoice is already cancelled.' });
    }

    // Check if returns already processed against this sale
    const returnsRow = await db.queryOne('SELECT COUNT(*) as count FROM returns WHERE original_sale_id = ?', [id]);
    const returnsCount = parseInt(returnsRow?.count || 0, 10);
    if (returnsCount > 0) {
      return res.status(400).json({
        error: 'Cannot cancel invoice directly because returns have already been processed for it.'
      });
    }

    const items = await db.query('SELECT * FROM sale_items WHERE sale_id = ?', [id]);

    await db.transaction(async (tx) => {
      // 1. Mark sale as cancelled
      await tx.execute(`
        UPDATE sales
        SET status = 'cancelled',
            cancelled_by = ?,
            cancellation_reason = ?
        WHERE id = ?
      `, [req.user.id, reason.trim(), id]);

      // 2. Return quantities to saleable stock
      for (const item of items) {
        const variant = await tx.queryOne('SELECT saleable_stock FROM product_variants WHERE id = ?', [item.variant_id]);
        if (variant) {
          await tx.execute(`
            UPDATE product_variants
            SET saleable_stock = saleable_stock + ?
            WHERE id = ?
          `, [item.quantity, item.variant_id]);

          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, 'SALE_CANCELLED', ?, ?, 'saleable', ?, ?, ?, ?)
          `, [
            item.variant_id,
            sale.invoice_number,
            item.quantity,
            variant.saleable_stock,
            Number(variant.saleable_stock) + Number(item.quantity),
            req.user.id,
            `Cancelled Invoice: ${sale.invoice_number} | Reason: ${reason}`
          ]);
        }
      }
    });

    res.json({ message: 'Invoice cancelled successfully and stock restored.' });
  } catch (err) {
    console.error('Error cancelling sale:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
