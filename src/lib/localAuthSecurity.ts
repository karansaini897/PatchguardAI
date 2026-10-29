import crypto from 'node:crypto';
import {
  isConfiguredSupabaseAnonKey,
  isConfiguredSupabaseUrl,
  isLocalDevAuthAllowed,
} from './supabaseBackendCore.ts';

export interface LocalDevAccountRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface LocalDevSessionRecord {
  accessToken: string;
  userId: string;
  email: string;
  expiresAt: number;
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Hashes a password using Node's `crypto.scryptSync` with a cryptographically random
 * 16-byte per-account salt. Never uses fast SHA-256 or static salts.
 * Format: `scrypt$<saltHex>$<derivedKeyHex>`
 */
export function hashPasswordScrypt(password: string, explicitSaltHex?: string): string {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be a string of at least 8 characters.');
  }
  const saltHex = explicitSaltHex || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${saltHex}$${derivedKey.toString('hex')}`;
}

/**
 * Verifies a candidate password against a `scrypt$<saltHex>$<derivedKeyHex>` record
 * using constant-time `crypto.timingSafeEqual` to prevent timing side-channel leaks.
 */
export function verifyPasswordScrypt(password: string, storedRecord: string): boolean {
  if (!password || !storedRecord || typeof storedRecord !== 'string') {
    return false;
  }
  const parts = storedRecord.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, saltHex, storedKeyHex] = parts;
  if (!saltHex || !storedKeyHex || storedKeyHex.length !== SCRYPT_KEYLEN * 2) {
    return false;
  }
  try {
    const saltBuf = Buffer.from(saltHex, 'hex');
    const storedKeyBuf = Buffer.from(storedKeyHex, 'hex');
    if (saltBuf.length === 0 || storedKeyBuf.length !== SCRYPT_KEYLEN) {
      return false;
    }
    const derivedKeyBuf = crypto.scryptSync(password, saltBuf, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    if (derivedKeyBuf.length !== storedKeyBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(derivedKeyBuf, storedKeyBuf);
  } catch {
    return false;
  }
}

export class LocalDevAuthForbiddenInProductionError extends Error {
  public readonly httpStatus = 503;
  public readonly category = 'MISSING_SERVER_CONFIG' as const;

  constructor(reason: string) {
    super(reason);
    this.name = 'LocalDevAuthForbiddenInProductionError';
  }
}

/**
 * Isolated, development-only in-memory authentication store used strictly when:
 * 1. `NODE_ENV !== 'production'`
 * 2. Live `SUPABASE_URL` / `SUPABASE_ANON_KEY` are not configured yet
 * 3. `ALLOW_LOCAL_DEV_AUTH !== 'false'`
 *
 * Contains ZERO hardcoded default accounts or passwords, hashes passwords with
 * per-user random-salted scrypt + timingSafeEqual, and refuses to operate in production.
 */
export class IsolatedLocalDevAuthStore {
  private accountsByEmail = new Map<string, LocalDevAccountRecord>();
  private sessionsByToken = new Map<string, LocalDevSessionRecord>();
  private getEnv: () => Record<string, string | undefined>;

  constructor(getEnv: () => Record<string, string | undefined> = () => process.env) {
    this.getEnv = getEnv;
  }

  public assertAllowed(): void {
    const check = isLocalDevAuthAllowed(this.getEnv());
    if (!check.allowed) {
      throw new LocalDevAuthForbiddenInProductionError(check.reason);
    }
  }

  public isEnabled(): boolean {
    return isLocalDevAuthAllowed(this.getEnv()).allowed;
  }

  public getAccountCount(): number {
    return this.accountsByEmail.size;
  }

  public registerAccount(
    rawEmail: string,
    password: string
  ): { account: LocalDevAccountRecord; session: LocalDevSessionRecord } {
    this.assertAllowed();
    const email = (rawEmail || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Provide a valid email address.');
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }

    if (this.accountsByEmail.has(email)) {
      const conflictErr = new Error(
        'An account with this email already exists in the local development sandbox. Please sign in.'
      ) as Error & { status?: number };
      conflictErr.status = 409;
      throw conflictErr;
    }

    const account: LocalDevAccountRecord = {
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPasswordScrypt(password),
      createdAt: new Date().toISOString(),
    };
    this.accountsByEmail.set(email, account);
    const session = this.issueSession(account);
    return { account, session };
  }

  public authenticateSignIn(
    rawEmail: string,
    password: string
  ): { account: LocalDevAccountRecord; session: LocalDevSessionRecord } | null {
    this.assertAllowed();
    const email = (rawEmail || '').trim().toLowerCase();
    const account = this.accountsByEmail.get(email);
    if (!account) {
      return null;
    }
    if (!verifyPasswordScrypt(password, account.passwordHash)) {
      return null;
    }
    const session = this.issueSession(account);
    return { account, session };
  }

  public verifySessionToken(rawToken: string): LocalDevSessionRecord | null {
    if (!this.isEnabled()) {
      return null;
    }
    const token = (rawToken || '').trim();
    if (!token) return null;
    const session = this.sessionsByToken.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessionsByToken.delete(token);
      return null;
    }
    return session;
  }

  public revokeSessionToken(rawToken: string): void {
    const token = (rawToken || '').trim();
    if (token) {
      this.sessionsByToken.delete(token);
    }
  }

  private issueSession(account: LocalDevAccountRecord): LocalDevSessionRecord {
    this.assertAllowed();
    const accessToken = `pg_dev_jwt_${crypto.randomBytes(24).toString('hex')}`;
    const session: LocalDevSessionRecord = {
      accessToken,
      userId: account.id,
      email: account.email,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000, // 8 hours
    };
    this.sessionsByToken.set(accessToken, session);
    return session;
  }
}

export function isLiveSupabaseServerConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  return isConfiguredSupabaseUrl(url) && isConfiguredSupabaseAnonKey(anonKey);
}
