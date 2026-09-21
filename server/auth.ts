import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { AuthTokenPayload } from './types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'msap_freshers_meet_2026_jwt_secret_token_default';
const SALT_ROUNDS = 10;

export async function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

export async function comparePassword(plainText: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plainText, hashed);
}

export function generateAdminToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function verifyAdminToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  admin?: AuthTokenPayload;
}

export function requireAdminAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'] as string;
  } else if (req.cookies && req.cookies.admin_token) {
    token = req.cookies.admin_token;
  }

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Access Denied: Authentication token required for Admin operations.',
    });
  }

  const decoded = verifyAdminToken(token);
  if (!decoded || (decoded.role !== 'ADMIN' && decoded.role !== 'SUPERADMIN')) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Access Denied: Insufficient administrative privileges.',
    });
  }

  req.admin = decoded;
  next();
}
