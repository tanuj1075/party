import crypto from 'crypto';
import Razorpay from 'razorpay';
import { getCachedEventSettings } from './eventSettings.js';

export interface CreateOrderParams {
  registrationId: number;
  amount?: number; // Optional on input, server resolves the active admin-configured registration price
  currency?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
}

export interface PaymentOrderResult {
  provider: string;
  orderId: string;
  amount: number;
  currency: string;
  keyId?: string;
  upiPaymentLink?: string;
  checkoutUrl?: string;
  notes?: Record<string, string>;
  isLive: boolean;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  orderId?: string;
  paymentId?: string;
  amount?: number;
  currency?: string;
  status?: 'PAID' | 'FAILED' | 'REFUNDED' | 'EXPIRED';
  paymentMethod?: string;
  eventId?: string;
  rawEvent?: any;
}

/**
 * Production Payment Gateway Service
 * Integrates Razorpay with native webhook HMAC verification, order generation,
 * amount integrity enforcement, and server-side payment verification.
 */
export class PaymentService {
  private provider: string;
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;
  private razorpayClient: Razorpay | null = null;

  constructor() {
    this.provider = (process.env.PAYMENT_PROVIDER || 'razorpay').toLowerCase();
    this.keyId = process.env.PAYMENT_KEY_ID || process.env.RAZORPAY_KEY_ID || '';
    this.keySecret = process.env.PAYMENT_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || '';
    this.webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || 'msap_freshers_webhook_secret_2026';
    
    if (this.keyId && this.keySecret) {
      try {
        this.razorpayClient = new Razorpay({
          key_id: this.keyId,
          key_secret: this.keySecret,
        });
        console.log(`[PAYMENT] Initialized ${this.provider.toUpperCase()} client in ${this.isLiveMode() ? 'LIVE' : 'TEST/SANDBOX'} mode. Key: ${this.keyId.substring(0, 8)}...`);
      } catch (err) {
        console.error('[PAYMENT] Error initializing Razorpay SDK:', err);
      }
    } else {
      console.warn('[PAYMENT] No PAYMENT_KEY_ID or PAYMENT_KEY_SECRET defined in .env. Awaiting real gateway keys.');
    }
  }

  getEventTicketPrice(): number {
    return getCachedEventSettings().registrationPrice;
  }

  getProviderName(): string {
    return this.provider;
  }

  getKeyId(): string {
    return this.keyId;
  }

  isLiveMode(): boolean {
    return this.keyId.startsWith('rzp_live_') || process.env.PAYMENT_ENVIRONMENT === 'production';
  }

  isTestMode(): boolean {
    return !this.isLiveMode();
  }

  /**
   * Creates a verified payment order.
   * Requirement 6: The server determines the price; never trusts frontend amount.
   */
  async createPaymentOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
    const { registrationId, customerName, customerEmail, customerPhone } = params;
    const amount = this.getEventTicketPrice(); // Strictly server-enforced
    const currency = 'INR';

    let orderId: string;

    if (this.razorpayClient) {
      try {
        // Create official Razorpay Order via SDK
        const rzpOrder = await this.razorpayClient.orders.create({
          amount: amount * 100, // Razorpay takes amount in smallest currency unit (paise)
          currency,
          receipt: `rcpt_reg_${registrationId}_${Date.now().toString(36)}`,
          notes: {
            registrationId: String(registrationId),
            customerName,
            customerEmail,
            customerPhone,
            event: "MSAP 53rd Freshers' Meet 2026",
          },
        });
        orderId = rzpOrder.id;
      } catch (err) {
        console.error('[PAYMENT] Failed to create Razorpay order via SDK:', err);
        throw new Error(`Payment gateway order creation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Sandbox / Test fallback order ID format
      orderId = `order_${this.provider.substring(0, 3)}_${registrationId}_${Date.now().toString(36)}`;
    }

    // Standard UPI intent URI for Google Pay / PhonePe / Paytm / BHIM
    const upiLink = `upi://pay?pa=msap.freshers26@icici&pn=MSAP%20Freshers%20Meet&am=${amount}&cu=INR&tr=${orderId}&tn=Freshers%20Meet%202026%20Pass%20Reg%20${registrationId}`;

    return {
      provider: this.provider,
      orderId,
      amount,
      currency,
      keyId: this.keyId,
      upiPaymentLink: upiLink,
      checkoutUrl: `/payment/checkout?order=${orderId}`,
      notes: {
        registrationId: String(registrationId),
        event: "MSAP 53rd Freshers' Meet 2026",
      },
      isLive: this.isLiveMode(),
    };
  }

  /**
   * Requirement 1 & 5: Verifies cryptographic webhook signature from the gateway.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !this.webhookSecret) {
      return false;
    }

    try {
      const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(bodyStr)
        .digest('hex');

      if (signatureHeader.length !== expectedSignature.length) {
        return false;
      }
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));
    } catch (err) {
      console.error('[PAYMENT] Webhook signature verification error:', err);
      return false;
    }
  }

  /**
   * Server-side verification of payment returned by Razorpay Checkout.
   * 1. Cryptographic HMAC SHA256 signature verification (order_id + "|" + payment_id)
   * 2. Gateway API verification: calls Razorpay API to verify status, amount, and order matching
   */
  async verifyCheckoutPayment(params: {
    orderId: string;
    paymentId: string;
    signature: string;
    registrationId: number;
    expectedAmount?: number;
  }): Promise<{ verified: boolean; error?: string; paymentDetails?: any }> {
    const { orderId, paymentId, signature } = params;

    // 1. Signature Verification
    if (!this.keySecret) {
      return { verified: false, error: 'Payment gateway secret key is not configured on server.' };
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const isSignatureValid =
      signature.length === expectedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

    if (!isSignatureValid) {
      return { verified: false, error: 'Invalid payment signature. Verification failed.' };
    }

    // 2. Gateway API Verification via SDK (if client active)
    if (this.razorpayClient) {
      try {
        const payment = await this.razorpayClient.payments.fetch(paymentId);
        
        // Verify order ID match
        if (payment.order_id !== orderId) {
          return { verified: false, error: `Order ID mismatch: expected ${orderId}, got ${payment.order_id}` };
        }

        // Verify captured/authorized status
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
          return { verified: false, error: `Payment is not successful. Current status: ${payment.status}` };
        }

        // Requirement 6: Verify payment amount against the amount captured for this order.
        // This preserves already-created orders when an administrator changes the current registration price.
        const storedAmount = Number(params.expectedAmount);
        const expectedAmount = Number.isFinite(storedAmount) && storedAmount > 0
          ? storedAmount
          : this.getEventTicketPrice();
        const expectedPaise = Math.round(expectedAmount * 100);
        const actualPaise = Number(payment.amount);
        if (actualPaise !== expectedPaise) {
          return {
            verified: false,
            error: `Payment amount mismatch: Expected ₹${expectedAmount.toFixed(2)} (${expectedPaise} paise), but received ₹${actualPaise / 100} (${actualPaise} paise). Ticket generation rejected.`,
          };
        }

        return { verified: true, paymentDetails: payment };
      } catch (apiErr) {
        console.error('[PAYMENT] Razorpay API fetch failed during verification:', apiErr);
        return { verified: false, error: `Gateway API verification error: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}` };
      }
    }

    return { verified: true };
  }

  /**
   * Normalizes incoming webhook payload into a uniform verification result
   */
  parseWebhookEvent(payload: any): WebhookVerificationResult {
    // Razorpay standard webhook schema
    if (payload.event && payload.payload) {
      const eventType = payload.event;
      const paymentEntity = payload.payload.payment?.entity;
      const orderEntity = payload.payload.order?.entity;

      const orderId = paymentEntity?.order_id || orderEntity?.id;
      const paymentId = paymentEntity?.id;
      const amount = paymentEntity?.amount ? paymentEntity.amount / 100 : orderEntity?.amount ? orderEntity.amount / 100 : undefined;
      const currency = paymentEntity?.currency || orderEntity?.currency || 'INR';
      const eventId = payload.account_id ? `${payload.event}_${paymentId || orderId}` : `evt_${Date.now()}`;

      let status: 'PAID' | 'FAILED' | 'REFUNDED' | 'EXPIRED' = 'FAILED';
      if (eventType === 'payment.captured' || eventType === 'order.paid') {
        status = 'PAID';
      } else if (eventType === 'payment.failed') {
        status = 'FAILED';
      } else if (eventType === 'refund.processed' || eventType === 'payment.refunded') {
        status = 'REFUNDED';
      }

      return {
        isValid: true,
        orderId,
        paymentId,
        amount,
        currency,
        status,
        paymentMethod: paymentEntity?.method || 'upi',
        eventId,
        rawEvent: payload,
      };
    }

    // Cashfree standard webhook schema
    if (payload.data && (payload.type || payload.event_time)) {
      const data = payload.data;
      const order = data.order;
      const payment = data.payment;

      let status: 'PAID' | 'FAILED' | 'REFUNDED' | 'EXPIRED' = 'FAILED';
      if (payment?.payment_status === 'SUCCESS' || data.order_status === 'PAID') {
        status = 'PAID';
      } else if (payment?.payment_status === 'FAILED') {
        status = 'FAILED';
      }

      return {
        isValid: true,
        orderId: order?.order_id || data.order_id,
        paymentId: payment?.cf_payment_id || String(payment?.payment_id),
        amount: order?.order_amount || payment?.payment_amount,
        currency: order?.order_currency || 'INR',
        status,
        paymentMethod: payment?.payment_group || 'upi',
        eventId: payload.event_time ? `cf_${payload.event_time}_${order?.order_id}` : undefined,
        rawEvent: payload,
      };
    }

    // Direct / Generic webhook payload
    const orderId = payload.orderId || payload.order_id || payload.gateway_order_id;
    const paymentId = payload.paymentId || payload.payment_id || payload.gateway_payment_id || `pay_${Date.now()}`;
    const amount = payload.amount !== undefined ? Number(payload.amount) : this.getEventTicketPrice();
    const currency = payload.currency || 'INR';
    const status = payload.status === 'PAID' || payload.status === 'SUCCESS' ? 'PAID' : (payload.status as any) || 'PAID';
    const eventId = payload.eventId || payload.event_id || `evt_${orderId}_${Date.now()}`;

    return {
      isValid: true,
      orderId,
      paymentId,
      amount,
      currency,
      status,
      paymentMethod: payload.paymentMethod || payload.payment_method || 'upi',
      eventId,
      rawEvent: payload,
    };
  }
}

export const paymentService = new PaymentService();
