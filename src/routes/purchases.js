const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/purchases - list all purchases
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { supplier_id, from_date, to_date } = req.query;

    let query = `
      SELECT 
        p.*,
        s.name as supplier_name,
        s.gstin as supplier_gstin,
        u.full_name as received_by_name,
        COUNT(pi.id) as item_count,
        COALESCE(SUM(pi.accepted_qty), 0) as total_accepted_qty,
        COALESCE(SUM(pi.damaged_qty), 0) as total_damaged_qty
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      JOIN users u ON u.id = p.received_by_user_id
      LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (supplier_id) {
      query += ` AND p.supplier_id = ?`;
      params.push(supplier_id);
    }
    if (from_date) {
      query += ` AND p.purchase_date >= ?`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND p.purchase_date <= ?`;
      params.push(to_date);
    }

    query += ` GROUP BY p.id, s.name, s.gstin, u.full_name ORDER BY p.purchase_date DESC, p.id DESC`;

    const purchases = await db.query(query, params);
    res.json(purchases);
  } catch (err) {
    console.error('Error fetching purchases:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchases/:id - get single purchase details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const purchase = await db.queryOne(`
      SELECT 
        p.*,
        s.name as supplier_name,
        s.contact_person as supplier_contact,
        s.phone as supplier_phone,
        s.gstin as supplier_gstin,
        u.full_name as received_by_name
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      JOIN users u ON u.id = p.received_by_user_id
      WHERE p.id = ?
    `, [req.params.id]);

    if (!purchase) return res.status(404).json({ error: 'Purchase entry not found.' });

    const items = await db.query(`
      SELECT 
        pi.*,
        v.sku,
        v.barcode,
        v.size,
        v.colour,
        pr.name as product_name
      FROM purchase_items pi
      JOIN product_variants v ON v.id = pi.variant_id
      JOIN products pr ON pr.id = v.product_id
      WHERE pi.purchase_id = ?
      ORDER BY pi.id ASC
    `, [purchase.id]);

    res.json({ ...purchase, items });
  } catch (err) {
    console.error('Error fetching purchase details:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchases - Record new purchase & stock inward
// Admin and Inventory Staff
router.post('/', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const {
    supplier_id,
    supplier_invoice_no,
    purchase_date,
    notes,
    items
  } = req.body;

  if (!supplier_id || !supplier_invoice_no || !purchase_date) {
    return res.status(400).json({ error: 'Supplier, invoice number, and purchase date are required.' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item must be entered in the purchase.' });
  }

  try {
    const supplier = await db.queryOne('SELECT id FROM suppliers WHERE id = ?', [supplier_id]);
    if (!supplier) {
      return res.status(404).json({ error: 'Selected supplier does not exist.' });
    }

    // Generate unique purchase number (e.g. PUR-YYYYMM-XXXX)
    const today = new Date();
    const yearMonth = today.toISOString().slice(0, 7).replace('-', '');
    const countRow = await db.queryOne("SELECT COUNT(*) as count FROM purchases WHERE purchase_number LIKE ?", [`PUR-${yearMonth}-%`]);
    const countToday = parseInt(countRow?.count || 0, 10);
    const purchaseNumber = `PUR-${yearMonth}-${String(countToday + 1).padStart(4, '0')}`;

    let totalAmount = 0;

    // Validate items
    for (const item of items) {
      if (!item.variant_id) {
        return res.status(400).json({ error: 'Variant ID is required for each item.' });
      }
      const variant = await db.queryOne('SELECT id FROM product_variants WHERE id = ?', [item.variant_id]);
      if (!variant) {
        return res.status(404).json({ error: `Variant ID ${item.variant_id} does not exist.` });
      }

      const receivedQty = Number(item.received_qty) || 0;
      const acceptedQty = Number(item.accepted_qty) || 0;
      const damagedQty = Number(item.damaged_qty) || 0;
      const rate = Number(item.purchase_rate) || 0;

      if (receivedQty <= 0) {
        return res.status(400).json({ error: 'Received quantity must be greater than 0.' });
      }
      if (acceptedQty + damagedQty !== receivedQty) {
        return res.status(400).json({
          error: `For item, accepted quantity (${acceptedQty}) + damaged quantity (${damagedQty}) must equal received quantity (${receivedQty}).`
        });
      }

      totalAmount += (acceptedQty + damagedQty) * rate;
    }

    const created = await db.transaction(async (tx) => {
      const pResult = await tx.execute(`
        INSERT INTO purchases (
          purchase_number, supplier_id, supplier_invoice_no, purchase_date, total_amount, received_by_user_id, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        purchaseNumber,
        supplier_id,
        supplier_invoice_no.trim(),
        purchase_date,
        totalAmount,
        req.user.id,
        notes ? notes.trim() : null
      ]);
      const purchaseId = pResult.lastInsertRowid;

      for (const item of items) {
        const receivedQty = Number(item.received_qty);
        const acceptedQty = Number(item.accepted_qty);
        const damagedQty = Number(item.damaged_qty) || 0;
        const rate = Number(item.purchase_rate);
        const itemCost = receivedQty * rate;

        await tx.execute(`
          INSERT INTO purchase_items (
            purchase_id, variant_id, received_qty, accepted_qty, damaged_qty, purchase_rate, total_cost
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [purchaseId, item.variant_id, receivedQty, acceptedQty, damagedQty, rate, itemCost]);

        const currentVariant = await tx.queryOne(
          'SELECT saleable_stock, damaged_stock, purchase_price FROM product_variants WHERE id = ?',
          [item.variant_id]
        );

        // Update variant stock: ONLY acceptedQty increases saleable_stock! damagedQty increases damaged_stock separately.
        await tx.execute(`
          UPDATE product_variants 
          SET saleable_stock = saleable_stock + ?,
              damaged_stock = damaged_stock + ?,
              purchase_price = ?
          WHERE id = ?
        `, [acceptedQty, damagedQty, rate, item.variant_id]);

        // Inward to stock ledger for accepted (saleable)
        if (acceptedQty > 0) {
          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            item.variant_id,
            'PURCHASE_INWARD',
            purchaseNumber,
            acceptedQty,
            'saleable',
            currentVariant.saleable_stock,
            Number(currentVariant.saleable_stock) + acceptedQty,
            req.user.id,
            `Supplier Inward: ${supplier_invoice_no}`
          ]);
        }

        // Inward to stock ledger for damaged/rejected
        if (damagedQty > 0) {
          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            item.variant_id,
            'PURCHASE_DAMAGED_INWARD',
            purchaseNumber,
            damagedQty,
            'damaged',
            currentVariant.damaged_stock,
            Number(currentVariant.damaged_stock) + damagedQty,
            req.user.id,
            `Damaged/Rejected on Inward: ${supplier_invoice_no}`
          ]);
        }
      }

      return await tx.queryOne('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
    });

    res.status(201).json(created);
  } catch (err) {
    console.error('Error processing purchase:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
