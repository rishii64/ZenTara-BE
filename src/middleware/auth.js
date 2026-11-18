const jwt = require('jsonwebtoken');
const { db } = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'zen_garments_super_secret_jwt_key_2026';

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication token is required.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.queryOne('SELECT id, username, full_name, role, status FROM users WHERE id = ?', [payload.id]);

    if (!user || user.status !== 'active') {
      return res.status(403).json({ error: 'User is inactive or no longer exists.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    console.error('authenticateToken error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    // Admin always has full access to all endpoints
    if (req.user.role === 'Admin') {
      return next();
    }

    if (allowedRoles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({
      error: `Access denied. Role '${req.user.role}' is not authorized for this action.`
    });
  };
}

module.exports = {
  JWT_SECRET,
  authenticateToken,
  requireRole
};
