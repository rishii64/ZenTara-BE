const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/daily-closing/today-summary - Live real-time summary for today
router.get('/today-summary', authenticateToken, async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);

    // Sales aggregates
    const salesSummary = await db.queryOne(`
      SELECT 
        COUNT(*) as total_invoices,
        COALESCE(SUM(rounded_amount), 0) as total_sales,
        COALESCE(SUM(discount_amount), 0) as total_discounts,
        COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN rounded_amount ELSE 0 END), 0) as cash_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN rounded_amount ELSE 0 END), 0) as upi_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'Card' THEN rounded_amount ELSE 0 END), 0) as card_sales,
        COALESCE(SUM(CASE WHEN payment_method NOT IN ('Cash', 'UPI', 'Card') THEN rounded_amount ELSE 0 END), 0) as other_sales
      FROM sales
      WHERE created_at::date = ?::date AND status = 'completed'
    `, [targetDate]);

    // Cancelled sales
    const cancelledSummary = await db.queryOne(`
      SELECT 
        COUNT(*) as cancelled_count,
        COALESCE(SUM(rounded_amount), 0) as cancelled_amount
      FROM sales
      WHERE created_at::date = ?::date AND status = 'cancelled'
    `, [targetDate]);

    // Returns today
    const returnsSummary = await db.queryOne(`
      SELECT 
        COUNT(*) as returns_count,
        COALESCE(SUM(total_return_amount), 0) as total_returns,
        COALESCE(SUM(CASE WHEN refund_method = 'Cash' THEN total_return_amount ELSE 0 END), 0) as cash_returns
      FROM returns
      WHERE created_at::date = ?::date
    `, [targetDate]);

    const cashSales = Number(salesSummary?.cash_sales || 0);
    const cashReturns = Number(returnsSummary?.cash_returns || 0);
    const expectedCashInDrawer = Math.max(0, cashSales - cashReturns);

    // Check if closing already submitted for today
    const existingClosing = await db.queryOne(`
      SELECT dc.*, u.full_name as closed_by_name, mu.full_name as approved_by_name
      FROM daily_closings dc
      JOIN users u ON u.id = dc.closed_by_user_id
      LEFT JOIN users mu ON mu.id = dc.approved_by_manager_id
      WHERE dc.closing_date::date = ?::date
    `, [targetDate]);

    res.json({
      date: targetDate,
      sales: salesSummary || { total_invoices: 0, total_sales: 0, total_discounts: 0, cash_sales: 0, upi_sales: 0, card_sales: 0, other_sales: 0 },
      cancelled: cancelledSummary || { cancelled_count: 0, cancelled_amount: 0 },
      returns: returnsSummary || { returns_count: 0, total_returns: 0, cash_returns: 0 },
      expectedCashInDrawer,
      existingClosing
    });
  } catch (err) {
    console.error('Error fetching today summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/daily-closing/history - Past daily closings
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 30 } = req.query;
    const history = await db.query(`
      SELECT 
        dc.*,
        u.full_name as closed_by_name,
        mu.full_name as approved_by_name
      FROM daily_closings dc
      JOIN users u ON u.id = dc.closed_by_user_id
      LEFT JOIN users mu ON mu.id = dc.approved_by_manager_id
      ORDER BY dc.closing_date DESC
      LIMIT ?
    `, [Number(limit) || 30]);

    res.json(history);
  } catch (err) {
    console.error('Error fetching closing history:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/daily-closing - Submit today's closing with physical cash count
// Roles: Cashier, Store Manager, Admin
router.post('/', authenticateToken, requireRole('Cashier', 'Store Manager', 'Admin'), async (req, res) => {
  const {
    closing_date = new Date().toISOString().slice(0, 10),
    physical_cash_counted = 0,
    cash_denominations,
    notes
  } = req.body;

  const targetDate = closing_date;

  try {
    // Compute live day summary
    const salesSummary = await db.queryOne(`
      SELECT 
        COUNT(*) as total_invoices,
        COALESCE(SUM(rounded_amount), 0) as total_sales,
        COALESCE(SUM(discount_amount), 0) as total_discounts,
        COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN rounded_amount ELSE 0 END), 0) as cash_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN rounded_amount ELSE 0 END), 0) as upi_sales,
        COALESCE(SUM(CASE WHEN payment_method = 'Card' THEN rounded_amount ELSE 0 END), 0) as card_sales
      FROM sales
      WHERE created_at::date = ?::date AND status = 'completed'
    `, [targetDate]);

    const cancelledRow = await db.queryOne(`
      SELECT COUNT(*) as count FROM sales WHERE created_at::date = ?::date AND status = 'cancelled'
    `, [targetDate]);
    const cancelledCount = parseInt(cancelledRow?.count || 0, 10);

    const returnsSummary = await db.queryOne(`
      SELECT 
        COALESCE(SUM(total_return_amount), 0) as total_returns,
        COALESCE(SUM(CASE WHEN refund_method = 'Cash' THEN total_return_amount ELSE 0 END), 0) as cash_returns
      FROM returns
      WHERE created_at::date = ?::date
    `, [targetDate]);

    const cashSales = Number(salesSummary?.cash_sales || 0);
    const cashReturns = Number(returnsSummary?.cash_returns || 0);
    const physicalCash = Number(physical_cash_counted) || 0;
    const expectedCash = Math.max(0, cashSales - cashReturns);
    const discrepancy = +(physicalCash - expectedCash).toFixed(2); // > 0 is cash surplus/overage, < 0 is shortage

    // Check if already closed
    const existing = await db.queryOne('SELECT id, status, approved_by_manager_id FROM daily_closings WHERE closing_date::date = ?::date', [targetDate]);

    const autoApprove = (req.user.role === 'Store Manager' || req.user.role === 'Admin');

    if (existing) {
      const finalStatus = autoApprove ? 'approved' : existing.status;
      const approvedBy = autoApprove ? req.user.id : existing.approved_by_manager_id;

      await db.execute(`
        UPDATE daily_closings
        SET total_sales_amount = ?,
            total_invoices_count = ?,
            cash_sales_amount = ?,
            upi_sales_amount = ?,
            card_sales_amount = ?,
            total_discounts_amount = ?,
            total_returns_amount = ?,
            cancelled_invoices_count = ?,
            physical_cash_counted = ?,
            cash_discrepancy = ?,
            cash_denominations = ?,
            notes = ?,
            closed_by_user_id = ?,
            approved_by_manager_id = ?,
            status = ?
        WHERE id = ?
      `, [
        salesSummary.total_sales,
        salesSummary.total_invoices,
        salesSummary.cash_sales,
        salesSummary.upi_sales,
        salesSummary.card_sales,
        salesSummary.total_discounts,
        returnsSummary.total_returns,
        cancelledCount,
        physicalCash,
        discrepancy,
        cash_denominations ? JSON.stringify(cash_denominations) : null,
        notes ? notes.trim() : null,
        req.user.id,
        approvedBy,
        finalStatus,
        existing.id
      ]);

      const updated = await db.queryOne('SELECT * FROM daily_closings WHERE id = ?', [existing.id]);
      return res.json(updated);
    }

    const result = await db.execute(`
      INSERT INTO daily_closings (
        closing_date, total_sales_amount, total_invoices_count, cash_sales_amount, upi_sales_amount,
        card_sales_amount, total_discounts_amount, total_returns_amount, cancelled_invoices_count,
        physical_cash_counted, cash_discrepancy, cash_denominations, notes, closed_by_user_id,
        approved_by_manager_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      targetDate,
      salesSummary.total_sales,
      salesSummary.total_invoices,
      salesSummary.cash_sales,
      salesSummary.upi_sales,
      salesSummary.card_sales,
      salesSummary.total_discounts,
      returnsSummary.total_returns,
      cancelledCount,
      physicalCash,
      discrepancy,
      cash_denominations ? JSON.stringify(cash_denominations) : null,
      notes ? notes.trim() : null,
      req.user.id,
      autoApprove ? req.user.id : null,
      autoApprove ? 'approved' : 'submitted'
    ]);

    const created = await db.queryOne('SELECT * FROM daily_closings WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json(created);
  } catch (err) {
    console.error('Error submitting daily closing:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/daily-closing/:id/approve - Store Manager / Admin approval
router.put('/:id/approve', authenticateToken, requireRole('Store Manager', 'Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const closing = await db.queryOne('SELECT * FROM daily_closings WHERE id = ?', [id]);
    if (!closing) return res.status(404).json({ error: 'Daily closing record not found.' });

    await db.execute(`
      UPDATE daily_closings
      SET status = 'approved',
          approved_by_manager_id = ?
      WHERE id = ?
    `, [req.user.id, id]);

    const updated = await db.queryOne(`
      SELECT dc.*, u.full_name as closed_by_name, mu.full_name as approved_by_name
      FROM daily_closings dc
      JOIN users u ON u.id = dc.closed_by_user_id
      LEFT JOIN users mu ON mu.id = dc.approved_by_manager_id
      WHERE dc.id = ?
    `, [id]);

    res.json({ message: 'Daily closing approved successfully.', closing: updated });
  } catch (err) {
    console.error('Error approving daily closing:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
