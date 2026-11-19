const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/reports/dashboard - Metrics for top dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Today's Sales & Transactions
    const todaySales = await db.queryOne(`
      SELECT 
        COALESCE(SUM(rounded_amount), 0) as today_revenue,
        COUNT(*) as today_transactions,
        COALESCE(SUM(discount_amount), 0) as today_discounts,
        COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN rounded_amount ELSE 0 END), 0) as today_cash,
        COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN rounded_amount ELSE 0 END), 0) as today_upi,
        COALESCE(SUM(CASE WHEN payment_method = 'Card' THEN rounded_amount ELSE 0 END), 0) as today_card
      FROM sales
      WHERE created_at::date = ?::date AND status = 'completed'
    `, [today]);

    // Today's Returns
    const todayReturns = await db.queryOne(`
      SELECT 
        COALESCE(SUM(total_return_amount), 0) as today_returns_amount,
        COUNT(*) as today_returns_count
      FROM returns
      WHERE created_at::date = ?::date
    `, [today]);

    // Total Products & Variants
    const prodRow = await db.queryOne('SELECT COUNT(*) as count FROM products');
    const varRow = await db.queryOne('SELECT COUNT(*) as count FROM product_variants');
    const productCount = parseInt(prodRow?.count || 0, 10);
    const variantCount = parseInt(varRow?.count || 0, 10);

    // Stock aggregates
    const stockSummary = await db.queryOne(`
      SELECT 
        COALESCE(SUM(saleable_stock), 0) as total_saleable_units,
        COALESCE(SUM(damaged_stock), 0) as total_damaged_units,
        COALESCE(SUM(saleable_stock * purchase_price), 0) as stock_valuation_purchase,
        COALESCE(SUM(saleable_stock * selling_price), 0) as stock_valuation_retail,
        COUNT(CASE WHEN saleable_stock <= reorder_level THEN 1 END) as low_stock_count,
        COUNT(CASE WHEN saleable_stock = 0 THEN 1 END) as out_of_stock_count
      FROM product_variants
    `);

    // Recent 6 Transactions
    const recentSales = await db.query(`
      SELECT 
        s.id,
        s.invoice_number,
        s.customer_name,
        s.customer_phone,
        s.rounded_amount,
        s.rounded_amount as net_amount,
        s.total_amount,
        s.payment_method,
        s.payment_method as payment_mode,
        s.status,
        s.created_at,
        u.full_name as cashier_name,
        COALESCE((SELECT SUM(quantity) FROM sale_items si WHERE si.sale_id = s.id), (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id), 1) as item_count
      FROM sales s
      JOIN users u ON u.id = s.cashier_id
      ORDER BY s.id DESC
      LIMIT 6
    `);

    res.json({
      today: {
        revenue: todaySales?.today_revenue || 0,
        transactions: parseInt(todaySales?.today_transactions || 0, 10),
        discounts: todaySales?.today_discounts || 0,
        cash_sales: todaySales?.today_cash || 0,
        upi_sales: todaySales?.today_upi || 0,
        card_sales: todaySales?.today_card || 0,
        returns_amount: todayReturns?.today_returns_amount || 0,
        returns_count: parseInt(todayReturns?.today_returns_count || 0, 10)
      },
      inventory: {
        product_count: productCount,
        variant_count: variantCount,
        total_saleable_units: stockSummary?.total_saleable_units || 0,
        total_damaged_units: stockSummary?.total_damaged_units || 0,
        valuation_purchase: Math.round(stockSummary?.stock_valuation_purchase || 0),
        valuation_retail: Math.round(stockSummary?.stock_valuation_retail || 0),
        low_stock_count: parseInt(stockSummary?.low_stock_count || 0, 10),
        out_of_stock_count: parseInt(stockSummary?.out_of_stock_count || 0, 10)
      },
      recentSales
    });
  } catch (err) {
    console.error('Error in dashboard reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/sales - Sales Report by date range or daily breakdown
router.get('/sales', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, group_by = 'daily' } = req.query;

    let query = '';
    const params = [];

    if (group_by === 'monthly') {
      query = `
        SELECT 
          TO_CHAR(created_at, 'YYYY-MM') as period,
          COUNT(*) as invoice_count,
          COALESCE(SUM(subtotal), 0) as gross_sales,
          COALESCE(SUM(discount_amount), 0) as discounts,
          COALESCE(SUM(taxable_amount), 0) as taxable_sales,
          COALESCE(SUM(gst_amount), 0) as total_gst,
          COALESCE(SUM(rounded_amount), 0) as net_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN rounded_amount ELSE 0 END), 0) as cash_total,
          COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN rounded_amount ELSE 0 END), 0) as upi_total,
          COALESCE(SUM(CASE WHEN payment_method = 'Card' THEN rounded_amount ELSE 0 END), 0) as card_total
        FROM sales
        WHERE status = 'completed'
      `;
    } else {
      query = `
        SELECT 
          TO_CHAR(created_at, 'YYYY-MM-DD') as period,
          COUNT(*) as invoice_count,
          COALESCE(SUM(subtotal), 0) as gross_sales,
          COALESCE(SUM(discount_amount), 0) as discounts,
          COALESCE(SUM(taxable_amount), 0) as taxable_sales,
          COALESCE(SUM(gst_amount), 0) as total_gst,
          COALESCE(SUM(rounded_amount), 0) as net_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN rounded_amount ELSE 0 END), 0) as cash_total,
          COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN rounded_amount ELSE 0 END), 0) as upi_total,
          COALESCE(SUM(CASE WHEN payment_method = 'Card' THEN rounded_amount ELSE 0 END), 0) as card_total
        FROM sales
        WHERE status = 'completed'
      `;
    }

    if (from_date) {
      query += ` AND created_at::date >= ?::date`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND created_at::date <= ?::date`;
      params.push(to_date);
    }

    query += ` GROUP BY period ORDER BY period DESC`;

    const rows = await db.query(query, params);

    // Totals
    const totals = rows.reduce((acc, curr) => ({
      invoice_count: acc.invoice_count + parseInt(curr.invoice_count || 0, 10),
      gross_sales: +(acc.gross_sales + Number(curr.gross_sales || 0)).toFixed(2),
      discounts: +(acc.discounts + Number(curr.discounts || 0)).toFixed(2),
      taxable_sales: +(acc.taxable_sales + Number(curr.taxable_sales || 0)).toFixed(2),
      total_gst: +(acc.total_gst + Number(curr.total_gst || 0)).toFixed(2),
      net_sales: +(acc.net_sales + Number(curr.net_sales || 0)).toFixed(2),
      cash_total: +(acc.cash_total + Number(curr.cash_total || 0)).toFixed(2),
      upi_total: +(acc.upi_total + Number(curr.upi_total || 0)).toFixed(2),
      card_total: +(acc.card_total + Number(curr.card_total || 0)).toFixed(2),
    }), {
      invoice_count: 0,
      gross_sales: 0,
      discounts: 0,
      taxable_sales: 0,
      total_gst: 0,
      net_sales: 0,
      cash_total: 0,
      upi_total: 0,
      card_total: 0
    });

    res.json({ rows, totals });
  } catch (err) {
    console.error('Error fetching sales reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchases - Purchase summary report
router.get('/purchases', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;

    let query = `
      SELECT 
        TO_CHAR(p.purchase_date, 'YYYY-MM-DD') as purchase_date,
        p.purchase_number,
        p.supplier_invoice_no,
        s.name as supplier_name,
        p.total_amount,
        COUNT(pi.id) as item_count,
        COALESCE(SUM(pi.accepted_qty), 0) as accepted_units,
        COALESCE(SUM(pi.damaged_qty), 0) as damaged_units,
        u.full_name as received_by
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      JOIN users u ON u.id = p.received_by_user_id
      LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (from_date) {
      query += ` AND p.purchase_date::date >= ?::date`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND p.purchase_date::date <= ?::date`;
      params.push(to_date);
    }

    query += ` GROUP BY p.id, s.name, u.full_name ORDER BY p.purchase_date DESC`;

    const rows = await db.query(query, params);
    const totalSpend = rows.reduce((acc, r) => acc + Number(r.total_amount || 0), 0);

    res.json({ rows, totalSpend });
  } catch (err) {
    console.error('Error fetching purchase reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/stock - Current Stock Valuation & Low Stock Report
router.get('/stock', authenticateToken, async (req, res) => {
  try {
    const { filter } = req.query; // 'low_stock', 'damaged', 'all'

    let query = `
      SELECT 
        v.id as variant_id,
        p.name as product_name,
        c.name as category_name,
        b.name as brand_name,
        v.size,
        v.colour,
        v.sku,
        v.barcode,
        v.purchase_price,
        v.selling_price,
        v.saleable_stock,
        v.damaged_stock,
        v.reorder_level,
        (v.saleable_stock * v.purchase_price) as purchase_value,
        (v.saleable_stock * v.selling_price) as retail_value,
        CASE 
          WHEN v.saleable_stock <= 0 THEN 'OUT_OF_STOCK'
          WHEN v.saleable_stock <= v.reorder_level THEN 'LOW_STOCK'
          ELSE 'NORMAL'
        END as stock_status
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE 1=1
    `;

    if (filter === 'low_stock') {
      query += ` AND v.saleable_stock <= v.reorder_level`;
    } else if (filter === 'damaged') {
      query += ` AND v.damaged_stock > 0`;
    }

    query += ` ORDER BY p.name ASC, v.size ASC`;

    const rows = await db.query(query);
    const summary = {
      total_items: rows.length,
      total_saleable_units: rows.reduce((acc, r) => acc + Number(r.saleable_stock || 0), 0),
      total_damaged_units: rows.reduce((acc, r) => acc + Number(r.damaged_stock || 0), 0),
      total_purchase_valuation: rows.reduce((acc, r) => acc + Number(r.purchase_value || 0), 0),
      total_retail_valuation: rows.reduce((acc, r) => acc + Number(r.retail_value || 0), 0),
    };

    res.json({ rows, summary });
  } catch (err) {
    console.error('Error fetching stock reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/returns - Returns & Exchanges summary
router.get('/returns', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;

    let query = `
      SELECT 
        r.id,
        r.return_number,
        TO_CHAR(r.created_at, 'YYYY-MM-DD') as return_date,
        r.type,
        s.invoice_number as original_invoice,
        r.total_return_amount,
        r.net_difference,
        r.refund_method,
        r.notes,
        u.full_name as processed_by,
        COUNT(ri.id) as item_count,
        COALESCE(SUM(CASE WHEN ri.condition = 'saleable' THEN ri.quantity ELSE 0 END), 0) as saleable_units,
        COALESCE(SUM(CASE WHEN ri.condition = 'damaged' THEN ri.quantity ELSE 0 END), 0) as damaged_units
      FROM returns r
      JOIN sales s ON s.id = r.original_sale_id
      JOIN users u ON u.id = r.processed_by_id
      LEFT JOIN return_items ri ON ri.return_id = r.id
      WHERE 1=1
    `;
    const params = [];

    if (from_date) {
      query += ` AND r.created_at::date >= ?::date`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND r.created_at::date <= ?::date`;
      params.push(to_date);
    }

    query += ` GROUP BY r.id, s.invoice_number, u.full_name ORDER BY r.created_at DESC`;

    const rows = await db.query(query, params);
    const totalRefundAmount = rows.reduce((acc, r) => acc + Number(r.total_return_amount || 0), 0);

    res.json({ rows, totalRefundAmount });
  } catch (err) {
    console.error('Error fetching return reports:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
