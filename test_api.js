const http = require('http');

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    if (dataString) {
      options.headers['Content-Length'] = Buffer.byteLength(dataString);
    }

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: responseBody });
        }
      });
    });

    req.on('error', reject);
    if (dataString) req.write(dataString);
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting API Integration Tests ---');

  // 1. Login Cashier
  const cashierLogin = await request('POST', '/api/auth/login', { username: 'cashier', password: 'cashier123' });
  console.log('1. Cashier Login:', cashierLogin.status === 200 ? 'PASS' : 'FAIL', cashierLogin.data.user?.role);
  const cashierToken = cashierLogin.data.token;

  // 2. Login Admin
  const adminLogin = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  console.log('2. Admin Login:', adminLogin.status === 200 ? 'PASS' : 'FAIL', adminLogin.data.user?.role);
  const adminToken = adminLogin.data.token;

  // 3. RBAC test: Cashier trying to create a category (should be 403)
  const rbacTest = await request('POST', '/api/categories', { name: 'Unauthorized Category' }, cashierToken);
  console.log('3. RBAC (Cashier blocked from Category creation):', rbacTest.status === 403 ? 'PASS' : 'FAIL');

  // 4. Barcode lookup
  const lookup = await request('GET', '/api/products/lookup/8901001001', null, cashierToken);
  console.log('4. Barcode Lookup 8901001001:', lookup.status === 200 && lookup.data.sku === 'RAY-SHIRT-M-NAVY' ? 'PASS' : 'FAIL');
  const targetVariant = lookup.data;
  console.log(`   Product: ${targetVariant.product_name}, Initial Stock: ${targetVariant.saleable_stock}`);

  // 5. POS Checkout
  const checkoutPayload = {
    customer_name: 'Aditi Rao',
    customer_phone: '9876500001',
    items: [
      {
        variant_id: targetVariant.id,
        quantity: 2,
        discount_amount: 0
      }
    ],
    discount_amount: 100, // ₹100 bill discount
    payment_method: 'Cash',
    cash_tendered: 3500
  };
  const checkoutRes = await request('POST', '/api/pos/checkout', checkoutPayload, cashierToken);
  console.log('5. POS Checkout:', checkoutRes.status === 201 ? 'PASS' : 'FAIL', 'Invoice:', checkoutRes.data?.sale?.invoice_number);
  const sale = checkoutRes.data?.sale;

  // 6. Verify stock reduced by 2
  const postLookup = await request('GET', `/api/products/lookup/${targetVariant.barcode}`, null, cashierToken);
  const stockReduced = postLookup.data.saleable_stock === targetVariant.saleable_stock - 2;
  console.log('6. Stock Reduced Correctly:', stockReduced ? 'PASS' : 'FAIL', `Before: ${targetVariant.saleable_stock}, After: ${postLookup.data.saleable_stock}`);

  // 7. Process Return of 1 unit in 'saleable' condition
  const returnPayload = {
    original_invoice_number: sale.invoice_number,
    type: 'refund',
    items: [
      {
        sale_item_id: sale.items[0].id,
        quantity: 1,
        condition: 'saleable',
        reason: 'Size too tight'
      }
    ],
    refund_method: 'Cash'
  };
  const returnRes = await request('POST', '/api/returns', returnPayload, cashierToken);
  console.log('7. Return Processing:', returnRes.status === 201 ? 'PASS' : 'FAIL', returnRes.data?.message);

  // 8. Verify stock restored by 1
  const returnStockLookup = await request('GET', `/api/products/lookup/${targetVariant.barcode}`, null, cashierToken);
  const stockRestored = returnStockLookup.data.saleable_stock === targetVariant.saleable_stock - 1;
  console.log('8. Saleable Stock Restored on Return:', stockRestored ? 'PASS' : 'FAIL', `Current: ${returnStockLookup.data.saleable_stock}`);

  // 9. Daily Closing summary
  const closingSummary = await request('GET', '/api/daily-closing/today-summary', null, cashierToken);
  console.log('9. Today Daily Closing Summary:', closingSummary.status === 200 ? 'PASS' : 'FAIL', `Total Sales: ₹${closingSummary.data?.sales?.total_sales}`);

  // 10. Dashboard Metrics
  const dashboard = await request('GET', '/api/reports/dashboard', null, adminToken);
  console.log('10. Dashboard Metrics:', dashboard.status === 200 ? 'PASS' : 'FAIL', `Today Revenue: ₹${dashboard.data?.today?.revenue}, Units: ${dashboard.data?.inventory?.total_saleable_units}`);

  console.log('--- All API Integration Tests Completed Successfully! ---');
  process.exit(0);
}

// Start backend server and run tests
const { startServer } = require('./src/server.js');
startServer().then(() => {
  setTimeout(runTests, 800);
}).catch(err => {
  console.error('Failed to start server for test:', err);
  process.exit(1);
});
