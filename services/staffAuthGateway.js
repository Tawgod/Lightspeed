import express from 'express';
import { createScannerSessions } from './scannerSessions.js';

// Shared staff authentication for Hobby Corner web tools.
// Timeclock remains the credential/identity authority; this service only issues
// short-lived signed sessions after Timeclock verifies the employee PIN.
export function createStaffAuthGateway({
  identity,
  sessionSecret,
  loginLimiter,
  clock = () => Date.now(),
  ttlSeconds = 900
} = {}) {
  if (!identity?.verifyPin || !identity?.authorize) {
    throw new Error('Timeclock staff identity is not configured.');
  }
  if (typeof loginLimiter !== 'function') {
    throw new Error('Staff login limiter is not configured.');
  }

  const sessions = createScannerSessions({
    secret: sessionSecret,
    ttlSeconds,
    now: clock
  });

  async function verifyEmployee(req) {
    const bearer = String(req.get('authorization') || '');
    if (!bearer.startsWith('Bearer ')) {
      throw Object.assign(new Error('Employee session required.'), { status: 401 });
    }

    const { employeeId } = sessions.verify(bearer.slice(7));
    const employee = await identity.authorize(employeeId);

    if (!employee?.id) {
      throw Object.assign(new Error('Employee access denied.'), { status: 403 });
    }
    return employee;
  }

  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/session', express.json({ limit: '1kb' }), async (req, res) => {
    const pin = req.body?.pin;
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return res.status(401).json({ error: 'Invalid employee credentials.' });
    }

    try {
      const allowed = await loginLimiter({ pin, ip: req.ip });
      if (!allowed) {
        return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
      }

      const employee = await identity.verifyPin(pin);
      const token = sessions.issue(employee);

      return res.json({
        token,
        expiresIn: sessions.ttlSeconds,
        employee: {
          id: employee.id,
          name: employee.name,
          role: employee.role || null,
          permissionSource: employee.permissionSource || 'timeclock_employee'
        }
      });
    } catch (error) {
      const status =
        error.status === 429 ? 429 :
        error.status === 503 ? 503 :
        error.status === 403 ? 403 :
        401;
      return res.status(status).json({ error: 'Employee sign-in failed.' });
    }
  });

  router.get('/session', async (req, res) => {
    try {
      const employee = await verifyEmployee(req);
      return res.json({
        ok: true,
        employee: {
          id: employee.id,
          name: employee.name,
          role: employee.role || null,
          permissionSource: employee.permissionSource || 'timeclock_employee'
        }
      });
    } catch (error) {
      return res.status(error.status || 401).json({ error: error.message });
    }
  });

  return { router, verifyEmployee, ttlSeconds: sessions.ttlSeconds };
}
