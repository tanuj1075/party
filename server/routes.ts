import express, { Request, Response } from 'express';
import QRCode from 'qrcode';
import {
  createAttendee,
  getAttendeeByAccessToken,
  lookupAttendee,
  lookupAttendeeSecure,
  confirmPaymentManualOverride,
  refundPaymentAndRevokePass,
  getPaymentTransactionByOrderId,
  getLatestPaymentTransactionByRegistrationId,
  verifyQrToken,
  performCheckIn,
  getDashboardStats,
  listAttendees,
  getAttendeeById,
  findAdminByEmail,
  isUsingMySQL,
  createPaymentTransaction,
  markPaymentSuccessfulAndGeneratePass,
  markPaymentFailed,
  getEventSettings,
  updateEventSettings,
  submitPaymentUtr,
  verifyPaymentAdmin,
  rejectPaymentAdmin,
} from './db.js';
import { comparePassword, generateAdminToken, requireAdminAuth, AuthenticatedRequest } from './auth.js';
import { sendTicketConfirmationEmail } from './email.js';
import { paymentService } from './payment.js';

const router = express.Router();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'msap_google_sheets_secret_token_2026';

// In-memory rate limiter for sensitive routes
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetTime < now) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count++;
  return true;
}

// ----------------------------------------------------
// 1. Health & Environment Status
// ----------------------------------------------------
router.get('/health', async (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'MSAP 53rd Freshers Meet 2026 API',
    event: "MSAP 53rd Freshers' Meet 2026",
    database: isUsingMySQL() ? 'MySQL (Live Connection)' : 'Relational Storage Engine',
    paymentProvider: paymentService.getProviderName(),
    paymentEnvironment: paymentService.isLiveMode() ? 'LIVE' : 'TEST / SANDBOX',
    ticketPrice: paymentService.getEventTicketPrice(),
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// 1.5 Public Event Settings
// Small cached payload so every visitor sees current time, venue and price.
// ----------------------------------------------------
router.get('/event-settings', async (_req: Request, res: Response) => {
  try {
    const settings = await getEventSettings();
    res.setHeader('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
    res.json({ success: true, settings });
  } catch (err) {
    console.error('Event settings error:', err);
    res.status(500).json({ error: 'Failed to load event settings.' });
  }
});

// ----------------------------------------------------
// 2. Public Registration Intake
// ----------------------------------------------------
router.post('/registrations', async (req: Request, res: Response) => {
  try {
    const { fullName, phone, email, college, category, rollId, courseClass, academicYear, paymentUtr } = req.body;

    if (!fullName || !phone || !email) {
      return res.status(400).json({ error: 'Full Name, Phone Number, and Email are required.' });
    }

    const attendee = await createAttendee({
      fullName: String(fullName).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      college: String(college || 'MSAP Architecture & Planning').trim(),
      category: category === 'SENIOR' ? 'SENIOR' : 'FRESHER',
      rollId: rollId ? String(rollId).trim() : undefined,
      courseClass: courseClass ? String(courseClass).trim() : undefined,
      academicYear: academicYear ? String(academicYear).trim() : undefined,
      paymentUtr: paymentUtr ? String(paymentUtr).trim() : undefined,
    });

    res.status(201).json({
      success: true,
      message: 'Registration saved. Please complete UPI payment and submit your transaction reference to receive your entry pass.',
      attendee: {
        id: attendee.id,
        registration_id: attendee.registration_id,
        ticket_id: attendee.ticket_id, // NULL until paid + verified
        full_name: attendee.full_name,
        category: attendee.category,
        payment_status: attendee.payment_status,
        entry_pass_status: attendee.entry_pass_status,
        access_token: attendee.access_token,
      },
    });
  } catch (err: unknown) {
    console.error('Error creating registration:', err);
    res.status(500).json({ error: 'Failed to process registration.' });
  }
});

// ----------------------------------------------------
// 3. Initiate / Create Payment Order for Existing Registration
// ----------------------------------------------------
router.post('/payments/create-order', async (req: Request, res: Response) => {
  try {
    const { accessToken, registrationId } = req.body;
    let attendee = null;

    if (accessToken) {
      attendee = await getAttendeeByAccessToken(String(accessToken));
    } else if (registrationId) {
      attendee = await getAttendeeById(Number(registrationId));
    }

    if (!attendee) {
      return res.status(404).json({ error: 'Attendee registration record not found.' });
    }

    if (attendee.payment_status === 'PAID') {
      return res.json({
        success: true,
        alreadyPaid: true,
        message: 'Payment already completed and verified.',
        ticketId: attendee.ticket_id,
        accessToken: attendee.access_token,
      });
    }

    const order = await paymentService.createPaymentOrder({
      registrationId: attendee.id,
      customerName: attendee.full_name,
      customerEmail: attendee.email,
      customerPhone: attendee.phone,
    });

    await createPaymentTransaction({
      registrationId: attendee.id,
      gatewayProvider: order.provider,
      gatewayOrderId: order.orderId,
      amount: order.amount,
      currency: order.currency,
    });

    res.json({
      success: true,
      order,
    });
  } catch (err) {
    console.error('Create payment order error:', err);
    res.status(500).json({ error: 'Failed to create payment order.' });
  }
});

// ----------------------------------------------------
// 4. Primary Payment Gateway Webhook Receiver
// Requirement 1, 5, 6, 7, 21: Production Webhook Endpoint
// ----------------------------------------------------
const handlePaymentWebhook = async (req: Request, res: Response) => {
  try {
    const signature =
      (req.headers['x-razorpay-signature'] as string) ||
      (req.headers['x-webhook-signature'] as string) ||
      (req.headers['x-cf-signature'] as string);

    // Cryptographic signature check on raw webhook body
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const hasSecret = Boolean(process.env.PAYMENT_WEBHOOK_SECRET);

    if (hasSecret) {
      const isValid = paymentService.verifyWebhookSignature(rawBody, signature);
      if (!isValid) {
        console.warn('[WEBHOOK SECURITY REJECT] Webhook signature failed verification.');
        return res.status(400).json({ error: 'Invalid webhook signature.' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.error('[CRITICAL] PAYMENT_WEBHOOK_SECRET is not configured in production environment.');
      return res.status(500).json({ error: 'Webhook secret not configured on server.' });
    }

    const event = paymentService.parseWebhookEvent(req.body);
    console.log(`[WEBHOOK EVENT] Status: ${event.status}, Order: ${event.orderId}, PaymentId: ${event.paymentId}, EventId: ${event.eventId}`);

    if (!event.orderId) {
      return res.status(400).json({ error: 'Missing order_id in webhook payload.' });
    }

    // Verify transaction exists in database and extract registration
    const existingTx = await getPaymentTransactionByOrderId(event.orderId);
    let registrationId: number;

    if (existingTx) {
      registrationId = existingTx.registration_id;
    } else {
      // Fallback parse format: order_rzp_<regId>_<timestamp>
      const orderParts = event.orderId.split('_');
      registrationId = orderParts.length >= 3 ? parseInt(orderParts[2], 10) : NaN;
    }

    if (isNaN(registrationId)) {
      return res.status(400).json({ error: 'Unrecognized order reference in webhook payload.' });
    }

    // Requirement 6: Verify amount received matches the amount stored when this order was created.
    // This prevents valid older orders from breaking after an admin price update.
    const expectedPrice = existingTx ? Number(existingTx.amount) : paymentService.getEventTicketPrice();
    if (event.amount !== undefined && (!Number.isFinite(Number(expectedPrice)) || Number(event.amount) !== Number(expectedPrice))) {
      console.error(`[PAYMENT SECURITY FRAUD] Order ${event.orderId} received ₹${event.amount}, required ₹${expectedPrice}. Pass creation rejected.`);
      return res.status(400).json({ error: 'Payment amount does not match ticket price.' });
    }

    if (event.status === 'PAID') {
      // Atomic MySQL transaction with FOR UPDATE row locking & idempotency
      const result = await markPaymentSuccessfulAndGeneratePass({
        registrationId,
        gatewayOrderId: event.orderId,
        gatewayPaymentId: event.paymentId,
        paymentMethod: event.paymentMethod,
        confirmedBy: `GATEWAY_WEBHOOK_${event.paymentMethod?.toUpperCase() || 'UPI'}`,
        eventId: event.eventId,
      });

      console.log(`[PASS ISSUED] Pass ${result.attendee.ticket_id} confirmed for ${result.attendee.full_name}`);

      // Dispatch ticket email confirmation
      if (result.isNewPass && result.attendee.email) {
        const passUrl = `${req.protocol}://${req.get('host')}/#ticket_${result.attendee.access_token}`;
        sendTicketConfirmationEmail({
          toEmail: result.attendee.email,
          recipientName: result.attendee.full_name,
          ticketId: result.attendee.ticket_id || 'FM26-XXX',
          passUrl,
          category: result.attendee.category,
        }).catch((e) => console.error('Email dispatch error:', e));
      }

      return res.json({ success: true, processed: true, ticketId: result.attendee.ticket_id });
    } else if (event.status === 'FAILED' || event.status === 'EXPIRED') {
      await markPaymentFailed({
        registrationId,
        gatewayOrderId: event.orderId,
        status: event.status,
      });
      return res.json({ success: true, processed: true, status: event.status });
    }

    res.json({ success: true, acknowledged: true });
  } catch (err) {
    console.error('Payment webhook error:', err);
    res.status(500).json({ error: 'Internal webhook error.' });
  }
};

// Mount both standard webhook endpoint and alias
router.post('/payment/webhook', handlePaymentWebhook);
router.post('/webhook/payment-gateway', handlePaymentWebhook);

// ----------------------------------------------------
// 5. Server-Side Checkout Payment Verification
// Requirement 1, 6, 7: Client Checkout Verification
// ----------------------------------------------------
router.post('/payments/verify-checkout', async (req: Request, res: Response) => {
  try {
    const { accessToken, orderId, paymentId, signature } = req.body;

    if (!accessToken || !orderId || !paymentId || !signature) {
      return res.status(400).json({
        error: 'Missing required parameters: accessToken, orderId, paymentId, and signature are mandatory.',
      });
    }

    const attendee = await getAttendeeByAccessToken(String(accessToken));
    if (!attendee) {
      return res.status(404).json({ error: 'Registration record not found.' });
    }

    if (attendee.payment_status === 'PAID') {
      return res.json({
        success: true,
        message: 'Payment already verified.',
        ticketId: attendee.ticket_id,
        attendee,
      });
    }

    // Requirement 7: Verify gateway_order_id belongs to this registration
    const existingTx = await getPaymentTransactionByOrderId(orderId);
    if (existingTx && existingTx.registration_id !== attendee.id) {
      console.warn(`[SECURITY FRAUD] Order ${orderId} does not belong to attendee #${attendee.id}`);
      return res.status(403).json({ error: 'Order ID mismatch: this order belongs to another registration.' });
    }

    // Verify HMAC signature & fetch API verification from payment gateway
    const verification = await paymentService.verifyCheckoutPayment({
      orderId: String(orderId),
      paymentId: String(paymentId),
      signature: String(signature),
      registrationId: attendee.id,
      expectedAmount: existingTx?.amount,
    });

    if (!verification.verified) {
      return res.status(400).json({ error: verification.error || 'Payment gateway verification failed.' });
    }

    // Payment successfully verified by cryptographic signature and/or gateway API
    const result = await markPaymentSuccessfulAndGeneratePass({
      registrationId: attendee.id,
      gatewayOrderId: orderId,
      gatewayPaymentId: paymentId,
      gatewaySignature: signature,
      paymentMethod: 'razorpay_checkout',
      confirmedBy: `GATEWAY_CHECKOUT_VERIFIED (Payment: ${paymentId})`,
      eventId: `checkout_${paymentId}`,
    });

    res.json({
      success: true,
      message: 'Payment verified! Your official entry pass and QR code have been generated.',
      ticketId: result.attendee.ticket_id,
      attendee: result.attendee,
    });
  } catch (err) {
    console.error('Checkout payment verification error:', err);
    res.status(500).json({ error: 'Failed to verify payment with gateway.' });
  }
});

// ----------------------------------------------------
// 6. Payment Status Polling (Requirement 17)
// Frontend checks this endpoint while gateway processes webhook
// ----------------------------------------------------
router.get('/payments/status/:registrationId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.registrationId, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid registration ID.' });
    }

    const attendee = await getAttendeeById(id);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee record not found.' });
    }

    res.json({
      success: true,
      registrationId: attendee.id,
      paymentStatus: attendee.payment_status,
      entryPassStatus: attendee.entry_pass_status,
      isPaid: attendee.payment_status === 'PAID',
      ticketId: attendee.ticket_id,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve payment status.' });
  }
});

router.get('/payments/status-by-token/:accessToken', async (req: Request, res: Response) => {
  try {
    const { accessToken } = req.params;
    const attendee = await getAttendeeByAccessToken(String(accessToken));

    if (!attendee) {
      return res.status(404).json({ error: 'Registration record not found.' });
    }

    res.json({
      success: true,
      registrationId: attendee.id,
      paymentStatus: attendee.payment_status,
      entryPassStatus: attendee.entry_pass_status,
      isPaid: attendee.payment_status === 'PAID',
      ticketId: attendee.ticket_id,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve payment status.' });
  }
});

// ----------------------------------------------------
// 7. Google Apps Script Webhook
// ----------------------------------------------------
router.post('/webhook/google-form', async (req: Request, res: Response) => {
  try {
    const tokenHeader = req.headers['x-webhook-token'] || req.query.secret;
    if (tokenHeader !== WEBHOOK_SECRET) {
      console.warn('[WEBHOOK] Unauthorized Google Apps Script webhook attempt rejected.');
      return res.status(401).json({ error: 'Unauthorized webhook invocation.' });
    }

    const { fullName, phone, email, college, category, rollId, paymentUtr, googleResponseId } = req.body;

    if (!fullName || !phone) {
      return res.status(400).json({ error: 'Incomplete Google Form response data.' });
    }

    const attendee = await createAttendee({
      fullName: String(fullName).trim(),
      phone: String(phone).trim(),
      email: String(email || '').trim().toLowerCase(),
      college: String(college || 'MSAP Architecture').trim(),
      category: category === 'SENIOR' ? 'SENIOR' : 'FRESHER',
      rollId: rollId ? String(rollId).trim() : undefined,
      paymentUtr: paymentUtr ? String(paymentUtr).trim() : undefined,
      googleResponseId: googleResponseId ? String(googleResponseId).trim() : undefined,
    });

    console.log(`[WEBHOOK] Synchronized Google Form response. Attendee #${attendee.id}`);

    res.status(200).json({
      success: true,
      ticketId: attendee.ticket_id,
      paymentStatus: attendee.payment_status,
      entryPassStatus: attendee.entry_pass_status,
      accessToken: attendee.access_token,
      attendeeId: attendee.id,
    });
  } catch (err: unknown) {
    console.error('Error processing Google Apps Script webhook:', err);
    res.status(500).json({ error: 'Webhook processing error.' });
  }
});

// ----------------------------------------------------
// 8. Secure Pass Lookup (Requirement 13: 2-Factor Lookup)
// ----------------------------------------------------
router.get('/tickets/lookup', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const phone = req.query.phone as string;
    const key = req.query.key as string; // email or rollId

    const ip = req.ip || 'global';
    if (!checkRateLimit(`lookup_${ip}`, 30, 60000)) {
      return res.status(429).json({ error: 'Too many search requests. Please wait a moment.' });
    }

    let attendee = null;

    // Secure 2-factor lookup if phone and key provided
    if (phone && key) {
      attendee = await lookupAttendeeSecure(phone, key);
    } else if (query && query.trim().length >= 3) {
      attendee = await lookupAttendee(query);
    } else {
      return res.status(400).json({ error: 'Please provide phone number and email/roll ID.' });
    }

    if (!attendee) {
      return res.status(404).json({ error: 'No matching registration found.' });
    }

    res.json({
      success: true,
      accessToken: attendee.access_token,
      ticketId: attendee.ticket_id,
      fullName: attendee.full_name,
      paymentStatus: attendee.payment_status,
      entryPassStatus: attendee.entry_pass_status,
    });
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: 'Internal lookup error.' });
  }
});

// ----------------------------------------------------
// 9. Secure Digital Pass Access (Public via Token)
// Requirement 9: QR Token contains only secure cryptographic token
// ----------------------------------------------------
router.get('/tickets/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const eventSettings = await getEventSettings();
    const attendee = await getAttendeeByAccessToken(token);

    if (!attendee) {
      return res.status(404).json({ error: 'Registration record not found or invalid token.' });
    }

    const paymentTransaction = await getLatestPaymentTransactionByRegistrationId(attendee.id);

    // Only generate scannable QR code if PAID and pass is ACTIVE
    let qrSvg = '';
    let qrDataUrl = '';
    const isPaid = attendee.payment_status === 'PAID' && attendee.qr_token;

    if (isPaid && attendee.qr_token) {
      try {
        qrSvg = await QRCode.toString(attendee.qr_token, {
          type: 'svg',
          margin: 1,
          color: {
            dark: '#0B0F19',
            light: '#FFFFFF',
          },
          errorCorrectionLevel: 'H',
        });
        qrDataUrl = await QRCode.toDataURL(attendee.qr_token, {
          margin: 1,
          width: 300,
          color: {
            dark: '#0B0F19',
            light: '#FFFFFF',
          },
          errorCorrectionLevel: 'H',
        });
      } catch (err) {
        console.error('QR code generation error:', err);
      }
    }

    res.json({
      success: true,
      ticket: {
        ticketId: attendee.ticket_id,
        registrationId: attendee.registration_id,
        fullName: attendee.full_name,
        category: attendee.category,
        college: attendee.college,
        courseClass: attendee.course_class,
        academicYear: attendee.academic_year,
        ticketStatus: attendee.ticket_status,
        paymentStatus: attendee.payment_status,
        paymentSubmittedAt: attendee.payment_submitted_at,
        rejectionReason: attendee.rejection_reason,
        entryPassStatus: attendee.entry_pass_status,
        checkInStatus: attendee.check_in_status,
        checkInTime: attendee.check_in_time,
        paymentUtr: attendee.payment_utr,
        qrToken: isPaid ? attendee.qr_token : null,
        qrSvg,
        qrDataUrl,
        eventDate: '02 OCT 2026',
        doorsOpen: eventSettings.time,
        venue: eventSettings.venue,
        eventName: "53rd Freshers' Meet 2026",
        organization: "Manipur Students' Association Pune (MSAP)",
        amount: `₹${paymentTransaction?.amount ?? paymentService.getEventTicketPrice()}`,
      },
    });
  } catch (err) {
    console.error('Ticket access error:', err);
    res.status(500).json({ error: 'Failed to retrieve digital pass.' });
  }
});

// ----------------------------------------------------
// 10. Admin Authentication (POST /api/admin/login)
// ----------------------------------------------------
router.post('/admin/login', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || 'admin_ip';
    if (!checkRateLimit(`login_${ip}`, 10, 60000)) {
      return res.status(429).json({ error: 'Too many login attempts. Please try again in 1 minute.' });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const admin = await findAdminByEmail(email);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid administrator credentials.' });
    }

    const isValid = await comparePassword(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid administrator credentials.' });
    }

    const token = generateAdminToken({
      id: admin.id,
      email: admin.email,
      role: admin.role,
    });

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

// ----------------------------------------------------
// 11. Authenticated Admin Endpoints (Require Admin JWT)
// ----------------------------------------------------

// Verify Admin Session
router.get('/admin/me', requireAdminAuth, (req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true, admin: req.admin });
});

// Event Settings: admin can change only the operational values requested.
router.get('/admin/event-settings', requireAdminAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const settings = await getEventSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error('Admin event settings fetch error:', err);
    res.status(500).json({ error: 'Failed to load event settings.' });
  }
});

router.put('/admin/event-settings', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { time, venue, registrationPrice } = req.body || {};
    if (typeof time !== 'string' || typeof venue !== 'string' || registrationPrice === undefined) {
      return res.status(400).json({ error: 'Time, venue, and registration price are required.' });
    }

    const settings = await updateEventSettings({
      time,
      venue,
      registrationPrice,
      adminId: req.admin?.id,
      adminEmail: req.admin?.email,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Event settings updated successfully.', settings });
  } catch (err: unknown) {
    console.error('Admin event settings update error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update event settings.' });
  }
});

// Admin Dashboard Stats
router.get('/admin/dashboard', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stats = await getDashboardStats();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to load dashboard statistics.' });
  }
});

// List / Search / Filter Attendees
router.get('/admin/attendees', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const search = req.query.search as string;
    const category = req.query.category as string;
    const paymentStatus = req.query.payment_status as string;
    const checkInStatus = req.query.check_in_status as string;
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);

    const result = await listAttendees({
      search,
      category,
      paymentStatus,
      checkInStatus,
      limit,
      offset,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('List attendees error:', err);
    res.status(500).json({ error: 'Failed to retrieve attendees.' });
  }
});

// Single Attendee Details
router.get('/admin/attendees/:id', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const attendee = await getAttendeeById(id);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee not found.' });
    }
    res.json({ success: true, attendee });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching attendee record.' });
  }
});

// Requirement 10: Emergency Admin Manual Payment Override
// Requires authenticated admin, admin ID, timestamp, and mandatory audit reason.
router.post('/admin/attendees/:id/confirm-payment', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (!reason || String(reason).trim().length < 5) {
      return res.status(400).json({
        error: 'A mandatory audit reason (minimum 5 characters) is required for emergency manual payment override.',
      });
    }

    const adminEmail = req.admin?.email || 'admin@msap.org';
    const adminId = req.admin?.id || 1;

    const attendee = await confirmPaymentManualOverride({
      attendeeId: id,
      adminId,
      adminEmail,
      reason: String(reason).trim(),
    });

    if (!attendee) {
      return res.status(404).json({ error: 'Attendee record not found.' });
    }

    console.log(`[MANUAL OVERRIDE] Attendee ${attendee.ticket_id} manually approved by Admin ID ${adminId} (${adminEmail}). Reason: ${reason}`);

    // Optional email dispatch hook
    if (attendee.email && attendee.ticket_id) {
      const passUrl = `${req.protocol}://${req.get('host')}/#ticket_${attendee.access_token}`;
      sendTicketConfirmationEmail({
        toEmail: attendee.email,
        recipientName: attendee.full_name,
        ticketId: attendee.ticket_id,
        passUrl,
        category: attendee.category,
      }).catch((e) => console.error('Email delivery error:', e));
    }

    res.json({
      success: true,
      message: `Emergency manual payment override confirmed for ${attendee.full_name} (${attendee.ticket_id}). Pass is now ACTIVE.`,
      badge: 'MANUAL_ADMIN_OVERRIDE',
      attendee,
    });
  } catch (err: unknown) {
    console.error('Payment confirmation error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to confirm payment.' });
  }
});

// Requirement 12: Admin Refund & Pass Revocation
router.post('/admin/attendees/:id/refund', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (!reason || String(reason).trim().length < 5) {
      return res.status(400).json({ error: 'A valid reason for refund and ticket revocation is mandatory.' });
    }

    const adminEmail = req.admin?.email || 'admin@msap.org';
    const adminId = req.admin?.id || 1;

    const result = await refundPaymentAndRevokePass({
      attendeeId: id,
      adminId,
      adminEmail,
      reason: String(reason).trim(),
    });

    res.json({
      success: true,
      message: `Payment marked REFUNDED and Pass ${result.attendee.ticket_id} REVOKED. Scanner will deny entry.`,
      attendee: result.attendee,
    });
  } catch (err: unknown) {
    console.error('Refund error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to process refund.' });
  }
});

// Verify QR Token (Camera Scanner Verification)
router.post('/admin/verify-qr', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ip = req.ip || 'admin_scanner';
    if (!checkRateLimit(`qr_scan_${ip}`, 120, 60000)) {
      return res.status(429).json({ error: 'Scanner telemetry busy. Please retry.' });
    }

    const { qr_token } = req.body;
    if (!qr_token) {
      return res.status(400).json({ error: 'QR token payload required.' });
    }

    const result = await verifyQrToken(String(qr_token));
    res.json(result);
  } catch (err) {
    console.error('Verify QR error:', err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// Confirm Check-In Admittance (Atomic Transaction with Row Locking)
router.post('/admin/check-in', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { attendee_id } = req.body;
    if (!attendee_id) {
      return res.status(400).json({ error: 'Attendee ID required for check-in.' });
    }

    const adminEmail = req.admin?.email || 'Gate Marshall';
    const result = await performCheckIn(parseInt(attendee_id, 10), adminEmail);

    if (!result.success) {
      return res.status(409).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Failed to record check-in.' });
  }
});

// ----------------------------------------------------
// UPI PAYMENT FLOW — Student Submits UTR / Transaction Reference
// ----------------------------------------------------
router.post('/payments/submit-utr', async (req: Request, res: Response) => {
  try {
    const { accessToken, registrationId, paymentUtr } = req.body;

    if (!paymentUtr || String(paymentUtr).trim().length < 5) {
      return res.status(400).json({ error: 'Please enter a valid payment reference / UTR number (at least 5 characters).' });
    }

    // Resolve identifier: access token takes priority
    const identifier = accessToken
      ? String(accessToken).trim()
      : registrationId
        ? String(registrationId).trim()
        : null;

    if (!identifier) {
      return res.status(400).json({ error: 'Access token or registration ID is required.' });
    }

    const updatedAttendee = await submitPaymentUtr({
      identifier,
      paymentUtr: String(paymentUtr).trim(),
    });

    console.log(`[UPI] UTR submitted by ${updatedAttendee.full_name} (${updatedAttendee.registration_id}): ${paymentUtr}`);

    res.json({
      success: true,
      message: 'Payment reference submitted. Awaiting admin verification. You will receive your ticket once verified.',
      attendee: {
        id: updatedAttendee.id,
        registration_id: updatedAttendee.registration_id,
        full_name: updatedAttendee.full_name,
        payment_status: updatedAttendee.payment_status,
        payment_utr: updatedAttendee.payment_utr,
        entry_pass_status: updatedAttendee.entry_pass_status,
        access_token: updatedAttendee.access_token,
      },
    });
  } catch (err: unknown) {
    console.error('UTR submission error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit payment reference.' });
  }
});

// ----------------------------------------------------
// ADMIN — Verify Student Payment and Issue Ticket
// ----------------------------------------------------
router.post('/admin/attendees/:id/verify-payment', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid attendee ID.' });

    const adminEmail = req.admin?.email || 'admin@msap.org';
    const adminId = req.admin?.id || 1;

    const { attendee, isNewPass } = await verifyPaymentAdmin({ attendeeId: id, adminEmail, adminId });

    console.log(`[ADMIN VERIFY] Payment verified for ${attendee.full_name} (${attendee.ticket_id}) by ${adminEmail}. New pass: ${isNewPass}`);

    // Send confirmation email (non-blocking)
    if (attendee.email && attendee.ticket_id) {
      const passUrl = `${req.protocol}://${req.get('host')}/#ticket_${attendee.access_token}`;
      sendTicketConfirmationEmail({
        toEmail: attendee.email,
        recipientName: attendee.full_name,
        ticketId: attendee.ticket_id,
        passUrl,
        category: attendee.category,
      }).catch((e) => console.error('Email delivery error:', e));
    }

    res.json({
      success: true,
      message: `Payment verified. Ticket ${attendee.ticket_id} issued to ${attendee.full_name}.`,
      isNewPass,
      attendee,
    });
  } catch (err: unknown) {
    console.error('Payment verification error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to verify payment.' });
  }
});

// ----------------------------------------------------
// ADMIN — Reject Student Payment Submission
// ----------------------------------------------------
router.post('/admin/attendees/:id/reject-payment', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid attendee ID.' });

    const { reason } = req.body;
    const adminEmail = req.admin?.email || 'admin@msap.org';
    const adminId = req.admin?.id || 1;

    const attendee = await rejectPaymentAdmin({
      attendeeId: id,
      adminEmail,
      adminId,
      reason: reason ? String(reason).trim() : undefined,
    });

    console.log(`[ADMIN REJECT] Payment rejected for ${attendee.full_name} (${attendee.registration_id}) by ${adminEmail}. Reason: ${reason}`);

    res.json({
      success: true,
      message: `Payment reference rejected for ${attendee.full_name}. Student may resubmit a correct UTR.`,
      attendee,
    });
  } catch (err: unknown) {
    console.error('Payment rejection error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to reject payment.' });
  }
});

export default router;
