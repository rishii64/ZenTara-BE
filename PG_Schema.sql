-- ============================================================================
-- ZENTARA by ZENTELEX - PostgreSQL Production Database Schema
-- Compatible with: Supabase, Neon, AWS RDS, Railway, Render, ElephantSQL,
--                  and Standard PostgreSQL 13+
-- ============================================================================

-- Ensure transaction safety
BEGIN;

-- ----------------------------------------------------------------------------
-- 0. COMPATIBILITY & HELPER FUNCTIONS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION strftime(format text, ts timestamptz) 
RETURNS text AS $$
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

-- ----------------------------------------------------------------------------
-- 1. USERS & ACCESS CONTROL (RBAC)
-- Roles: Admin, Store Manager, Inventory Staff, Cashier
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK(role IN ('Admin', 'Store Manager', 'Inventory Staff', 'Cashier')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 2. CATEGORIES
-- Garment types (Men's Formal, Women's Ethnic, Denim, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 3. BRANDS
-- Garment brands & labels (Raymond, Allen Solly, Peter England, Levi's, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 4. SUPPLIERS & TEXTILE MILLS
-- Wholesale vendors, textile mills & distributors
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 5. PRODUCTS MASTER
-- Parent garment style / model catalog
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 6. PRODUCT VARIANTS (SKUs & Barcodes)
-- Product + Size + Colour with dedicated Barcode, Stock & Price points
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 7. PURCHASES (Stock Inward)
-- Records shipments received from textile mills & suppliers
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 8. PURCHASE ITEMS
-- Itemized line items of purchase inwards (Accepted vs Damaged/Rejected)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 9. STOCK LEDGER & AUDIT TRAIL
-- Full transaction audit history (Purchases, Sales, Returns, Adjustments)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 10. SALES / INVOICES
-- Completed POS customer billing records with GST breakdowns
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 11. SALE LINE ITEMS
-- Garment units sold per invoice with tax snapshot & returned count
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 12. RETURNS & EXCHANGES
-- Customer returns, store credits, refunds & item replacements
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 13. RETURN LINE ITEMS
-- Returned garments with condition (saleable vs damaged) & reason
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 14. DAILY CLOSINGS & CASH DRAWER RECONCILIATION
-- End-of-day register closure, denomination counts & variance tracking
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 15. STORE SETTINGS
-- Key-value configuration for store name, GSTIN, receipt footer, etc.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- 16. PERFORMANCE INDEXES
-- Optimized for high-throughput barcode scanning and POS invoice lookups
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_variant_barcode ON product_variants(barcode);
CREATE INDEX IF NOT EXISTS idx_variant_sku ON product_variants(sku);
CREATE INDEX IF NOT EXISTS idx_variant_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_number);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_cashier ON sales(cashier_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_variant ON sale_items(variant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_number ON purchases(purchase_number);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_variant ON stock_ledger(variant_id);
CREATE INDEX IF NOT EXISTS idx_returns_number ON returns(return_number);
CREATE INDEX IF NOT EXISTS idx_daily_closing_date ON daily_closings(closing_date);

-- ----------------------------------------------------------------------------
-- 17. DEFAULT ESSENTIAL DATA (Store Configuration & Standard Roles)
-- ----------------------------------------------------------------------------
INSERT INTO store_settings (key, value) VALUES
  ('store_name', 'ZENTARA'),
  ('tagline', 'Premium Retail Garment & Fashion Flagship'),
  ('address_line1', '42, Commercial Boulevard, Fashion Avenue'),
  ('city_state_zip', 'Bengaluru, Karnataka - 560001'),
  ('phone', '+91 98765 43210'),
  ('email', 'billing@zentelex.com'),
  ('gstin', '29AABCG1234M1Z2'),
  ('currency_symbol', '₹'),
  ('receipt_footer', 'Thank you for shopping at ZENTARA! Exchanges within 7 days with tags intact and original invoice.'),
  ('default_gst_rate', '5.0'),
  ('reorder_threshold', '5')
ON CONFLICT (key) DO NOTHING;

-- Default System Accounts (passwords: admin123, manager123, inventory123, cashier123)
INSERT INTO users (username, password_hash, full_name, role, status) VALUES
  ('admin', '$2b$10$yo0UQyNCnnwirnzd.M4oteiMawLElJRi0VCZ7mpxJh66PZDMtF6BC', 'Rajesh Verma (Admin)', 'Admin', 'active'),
  ('manager', '$2b$10$yo0UQyNCnnwirnzd.M4otevlu2b5vcEElRaHxvTopbVxSrl6oOf8u', 'Priya Sharma (Store Manager)', 'Store Manager', 'active'),
  ('inventory', '$2b$10$yo0UQyNCnnwirnzd.M4oteDkkR1MHZNKwUUGp7.eAtHWUPK030l9q', 'Arun Kumar (Inventory Head)', 'Inventory Staff', 'active'),
  ('cashier', '$2b$10$yo0UQyNCnnwirnzd.M4otegPkFT3s02rsh/G6GA8dxxHA7U1rPd1S', 'Sneha Patel (Cashier)', 'Cashier', 'active')
ON CONFLICT (username) DO NOTHING;

COMMIT;
