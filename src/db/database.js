const { Pool, types } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Automatically parse PostgreSQL NUMERIC/DECIMAL as JavaScript floats
types.setTypeParser(1700, val => (val === null ? null : parseFloat(val)));
// Automatically parse PostgreSQL BIGINT (int8) as JavaScript integers
types.setTypeParser(20, val => (val === null ? null : parseInt(val, 10)));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'zentara',
  user: process.env.DB_USERNAME === 'postgress' ? 'postgres' : (process.env.DB_USERNAME || process.env.DB_USER || 'postgres'),
  password: process.env.DB_PASSWORD || 'rishiPDB',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Test connection on boot
pool.on('error', (err) => {
  console.error('[PostgreSQL Pool Error]', err);
});

// Converts '?' placeholders to PostgreSQL '$1, $2, ...' placeholders
function formatSql(text) {
  let index = 1;
  return text.replace(/\?/g, () => `$${index++}`);
}

const db = {
  pool,
  formatSql,

  /**
   * Run query and return all rows
   */
  query: async (text, params = []) => {
    const formatted = formatSql(text);
    const res = await pool.query(formatted, params);
    return res.rows;
  },

  /**
   * Run query and return first row or null
   */
  queryOne: async (text, params = []) => {
    const formatted = formatSql(text);
    const res = await pool.query(formatted, params);
    return res.rows[0] || null;
  },

  /**
   * Execute an INSERT, UPDATE, or DELETE query.
   * Automatically appends 'RETURNING id, *' to INSERT statements if not present.
   */
  execute: async (text, params = []) => {
    let formatted = formatSql(text);
    if (/^\s*INSERT\s+INTO/i.test(formatted) && !/RETURNING/i.test(formatted)) {
      formatted = `${formatted} RETURNING *`;
    }
    const res = await pool.query(formatted, params);
    return {
      rowCount: res.rowCount,
      rows: res.rows,
      lastInsertRowid: res.rows[0]?.id || null,
      firstRow: res.rows[0] || null
    };
  },

  /**
   * Execute callback within a PostgreSQL transaction with automatic BEGIN/COMMIT/ROLLBACK.
   */
  transaction: async (callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query: async (text, params = []) => {
          const res = await client.query(formatSql(text), params);
          return res.rows;
        },
        queryOne: async (text, params = []) => {
          const res = await client.query(formatSql(text), params);
          return res.rows[0] || null;
        },
        execute: async (text, params = []) => {
          let formatted = formatSql(text);
          if (/^\s*INSERT\s+INTO/i.test(formatted) && !/RETURNING/i.test(formatted)) {
            formatted = `${formatted} RETURNING *`;
          }
          const res = await client.query(formatted, params);
          return {
            rowCount: res.rowCount,
            rows: res.rows,
            lastInsertRowid: res.rows[0]?.id || null,
            firstRow: res.rows[0] || null
          };
        }
      };
      const result = await callback(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create compatibility functions if needed (e.g. strftime for reports)
    await client.query(`
      CREATE OR REPLACE FUNCTION strftime(format text, ts timestamptz) RETURNS text AS $$
      BEGIN
        IF format = '%Y-%m' THEN
          RETURN to_char(ts, 'YYYY-MM');
        ELSIF format = '%Y-%m-%d' THEN
          RETURN to_char(ts, 'YYYY-MM-DD');
        ELSE
          RETURN to_char(ts, 'YYYY-MM-DD');
        END IF;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `);

    // Schema Tables Definition
    await client.query(`
      -- Users Table (4 Roles: Admin, Store Manager, Inventory Staff, Cashier)
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK(role IN ('Admin', 'Store Manager', 'Inventory Staff', 'Cashier')),
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Categories
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Brands
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Suppliers
      CREATE TABLE IF NOT EXISTS suppliers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        contact_person VARCHAR(255),
        phone VARCHAR(50),
        email VARCHAR(255),
        address TEXT,
        gstin VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Products Master
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
        hsn_code VARCHAR(50) NOT NULL DEFAULT '6109',
        gst_rate NUMERIC(5, 2) NOT NULL DEFAULT 5.0,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Product Variants (Product + Size + Colour = Unique SKU & Barcode)
      CREATE TABLE IF NOT EXISTS product_variants (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        size VARCHAR(50) NOT NULL,
        colour VARCHAR(50) NOT NULL,
        sku VARCHAR(100) UNIQUE NOT NULL,
        barcode VARCHAR(100) UNIQUE NOT NULL,
        purchase_price NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        mrp NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        saleable_stock INTEGER NOT NULL DEFAULT 0,
        damaged_stock INTEGER NOT NULL DEFAULT 0,
        reorder_level INTEGER NOT NULL DEFAULT 5,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id, size, colour)
      );

      -- Purchases (Stock Inward)
      CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        purchase_number VARCHAR(100) UNIQUE NOT NULL,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        supplier_invoice_no VARCHAR(100) NOT NULL,
        purchase_date DATE NOT NULL,
        total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        received_by_user_id INTEGER NOT NULL REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Purchase Items (Tracks accepted vs damaged received)
      CREATE TABLE IF NOT EXISTS purchase_items (
        id SERIAL PRIMARY KEY,
        purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
        variant_id INTEGER NOT NULL REFERENCES product_variants(id),
        received_qty INTEGER NOT NULL,
        accepted_qty INTEGER NOT NULL,
        damaged_qty INTEGER NOT NULL DEFAULT 0,
        purchase_rate NUMERIC(12, 2) NOT NULL,
        total_cost NUMERIC(12, 2) NOT NULL
      );

      -- Stock Ledger (Full inward/outward history & audit trail)
      CREATE TABLE IF NOT EXISTS stock_ledger (
        id SERIAL PRIMARY KEY,
        variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
        transaction_type VARCHAR(100) NOT NULL,
        reference_id VARCHAR(100),
        quantity_change INTEGER NOT NULL,
        stock_type VARCHAR(20) NOT NULL DEFAULT 'saleable' CHECK(stock_type IN ('saleable', 'damaged')),
        stock_before INTEGER NOT NULL,
        stock_after INTEGER NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Sales / Invoices
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        invoice_number VARCHAR(100) UNIQUE NOT NULL,
        customer_name VARCHAR(255) DEFAULT 'Walk-in Customer',
        customer_phone VARCHAR(50),
        subtotal NUMERIC(12, 2) NOT NULL,
        discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        discount_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.0,
        discount_approved_by INTEGER REFERENCES users(id),
        taxable_amount NUMERIC(12, 2) NOT NULL,
        gst_amount NUMERIC(12, 2) NOT NULL,
        cgst_amount NUMERIC(12, 2) NOT NULL,
        sgst_amount NUMERIC(12, 2) NOT NULL,
        total_amount NUMERIC(12, 2) NOT NULL,
        rounded_amount NUMERIC(12, 2) NOT NULL,
        cashier_id INTEGER NOT NULL REFERENCES users(id),
        payment_method VARCHAR(20) NOT NULL CHECK(payment_method IN ('Cash', 'UPI', 'Card', 'Split')),
        cash_tendered NUMERIC(12, 2) DEFAULT 0.0,
        change_returned NUMERIC(12, 2) DEFAULT 0.0,
        payment_details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'cancelled')),
        cancelled_by INTEGER REFERENCES users(id),
        cancellation_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Sale Line Items
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        variant_id INTEGER NOT NULL REFERENCES product_variants(id),
        product_name VARCHAR(255) NOT NULL,
        size VARCHAR(50) NOT NULL,
        colour VARCHAR(50) NOT NULL,
        sku VARCHAR(100) NOT NULL,
        hsn_code VARCHAR(50) NOT NULL,
        unit_price NUMERIC(12, 2) NOT NULL,
        quantity INTEGER NOT NULL,
        discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        gst_rate NUMERIC(5, 2) NOT NULL,
        gst_amount NUMERIC(12, 2) NOT NULL,
        line_total NUMERIC(12, 2) NOT NULL,
        returned_quantity INTEGER NOT NULL DEFAULT 0
      );

      -- Returns and Exchanges
      CREATE TABLE IF NOT EXISTS returns (
        id SERIAL PRIMARY KEY,
        return_number VARCHAR(100) UNIQUE NOT NULL,
        original_sale_id INTEGER NOT NULL REFERENCES sales(id),
        type VARCHAR(20) NOT NULL CHECK(type IN ('refund', 'exchange')),
        processed_by_id INTEGER NOT NULL REFERENCES users(id),
        manager_approved_by_id INTEGER REFERENCES users(id),
        total_return_amount NUMERIC(12, 2) NOT NULL,
        replacement_sale_id INTEGER REFERENCES sales(id),
        net_difference NUMERIC(12, 2) DEFAULT 0.0,
        refund_method VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Return Line Items
      CREATE TABLE IF NOT EXISTS return_items (
        id SERIAL PRIMARY KEY,
        return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        variant_id INTEGER NOT NULL REFERENCES product_variants(id),
        quantity INTEGER NOT NULL,
        unit_price NUMERIC(12, 2) NOT NULL,
        refund_amount NUMERIC(12, 2) NOT NULL,
        condition VARCHAR(20) NOT NULL CHECK(condition IN ('saleable', 'damaged')),
        reason TEXT NOT NULL
      );

      -- Daily Closing & Reconciliation
      CREATE TABLE IF NOT EXISTS daily_closings (
        id SERIAL PRIMARY KEY,
        closing_date DATE UNIQUE NOT NULL,
        total_sales_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        total_invoices_count INTEGER NOT NULL DEFAULT 0,
        cash_sales_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        upi_sales_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        card_sales_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        total_discounts_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        total_returns_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        cancelled_invoices_count INTEGER NOT NULL DEFAULT 0,
        physical_cash_counted NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        cash_discrepancy NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
        cash_denominations TEXT,
        notes TEXT,
        closed_by_user_id INTEGER NOT NULL REFERENCES users(id),
        approved_by_manager_id INTEGER REFERENCES users(id),
        status VARCHAR(20) NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted', 'approved')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Store Settings
      CREATE TABLE IF NOT EXISTS store_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variant_barcode ON product_variants(barcode);
      CREATE INDEX IF NOT EXISTS idx_variant_sku ON product_variants(sku);
      CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at);
      CREATE INDEX IF NOT EXISTS idx_stock_ledger_variant ON stock_ledger(variant_id);

      -- Ensure stock_ledger cascades when variants/products are deleted
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'stock_ledger_variant_id_fkey' 
          AND table_name = 'stock_ledger'
        ) THEN
          ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_variant_id_fkey;
        END IF;
        ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_variant_id_fkey 
          FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN NULL;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('[PostgreSQL] Database schema verified and ready.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PostgreSQL] Schema initialization failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  db,
  initSchema
};
