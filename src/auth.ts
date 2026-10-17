/**
 * AI Energy Guardian - Secure Authentication & Role-Based Authorization
 *
 * Implements:
 * - Scrypt password hashing with unique per-user salts
 * - Constant-time comparison to prevent timing attacks
 * - Cryptographically signed JWT tokens with expiration
 * - Server-authoritative role enforcement (Admin, Operator, Occupant)
 * - Administrative user management & audit tracking
 * - Role-specific diagnostic permission checks
 */

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { Request, Response, NextFunction } from "express";

export type UserRole = "admin" | "operator" | "occupant" | "user";

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  passwordHash: string;
  salt: string;
  createdAt: string;
  lastLoginAt?: string;
  assignedRoom?: string; // Assigned classroom for operators/occupants
}

export interface JWTPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// Secret for signing JWTs
const JWT_SECRET = process.env.JWT_SECRET || "ai_energy_guardian_secure_secret_key_2026";
const TOKEN_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

// Helper functions for base64url encoding
function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

export function signToken(payload: Omit<JWTPayload, "iat" | "exp">, expiresInSeconds = TOKEN_EXPIRY_SECONDS): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;
  const fullPayload: JWTPayload = { ...payload, iat, exp };

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const encodedSignature = base64UrlEncode(signature);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const expectedSignature = createHmac("sha256", JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const expectedEncodedSignature = base64UrlEncode(expectedSignature);

    if (encodedSignature !== expectedEncodedSignature) {
      return null;
    }

    const payload: JWTPayload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const candidateHash = scryptSync(password, salt, 64).toString("hex");
    const candidateBuf = Buffer.from(candidateHash, "hex");
    const expectedBuf = Buffer.from(hash, "hex");
    if (candidateBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(candidateBuf, expectedBuf);
  } catch {
    return false;
  }
}

import {
  getSupabaseClient,
  isSupabaseConfigured,
  logAuditEventToDb,
  DbUser,
} from "./supabase.js";

// User store with pre-configured Admin, Operator, and Normal user accounts,
// backed by real Supabase PostgreSQL persistence when configured.
class UserStore {
  private users: Map<string, UserRecord> = new Map();
  private dbSyncPromise: Promise<void> | null = null;

  constructor() {
    this.initDefaultUsers();
    // Non-blocking initialization with Supabase if configured
    this.syncWithDatabase().catch((err) => {
      console.warn("[UserStore] Background Supabase sync notice:", err?.message || err);
    });
  }

  private initDefaultUsers(): void {
    // Default Admin user
    const adminPass = hashPassword("AdminGuardian2026!");
    const adminUser: UserRecord = {
      id: "usr_admin_001",
      email: "admin@energyguardian.ai",
      role: "admin",
      passwordHash: adminPass.hash,
      salt: adminPass.salt,
      createdAt: new Date().toISOString(),
      assignedRoom: "ALL_ROOMS",
    };
    this.users.set(adminUser.id, adminUser);

    // Facility & Sensor Operator
    const operatorPass = hashPassword("OperatorGuardian2026!");
    const operatorUser: UserRecord = {
      id: "usr_operator_002",
      email: "operator@energyguardian.ai",
      role: "operator",
      passwordHash: operatorPass.hash,
      salt: operatorPass.salt,
      createdAt: new Date().toISOString(),
      assignedRoom: "Lab Classroom 101",
    };
    this.users.set(operatorUser.id, operatorUser);

    // Normal Person / Classroom Occupant / Student
    const studentPass = hashPassword("StudentGuardian2026!");
    const studentUser: UserRecord = {
      id: "usr_occupant_003",
      email: "student@energyguardian.ai",
      role: "occupant",
      passwordHash: studentPass.hash,
      salt: studentPass.salt,
      createdAt: new Date().toISOString(),
      assignedRoom: "Lab Classroom 101",
    };
    this.users.set(studentUser.id, studentUser);

    // Default Normal User alias
    const userPass = hashPassword("UserGuardian2026!");
    const normalUser: UserRecord = {
      id: "usr_normal_004",
      email: "user@energyguardian.ai",
      role: "occupant",
      passwordHash: userPass.hash,
      salt: userPass.salt,
      createdAt: new Date().toISOString(),
      assignedRoom: "Lab Classroom 101",
    };
    this.users.set(normalUser.id, normalUser);
  }

  /**
   * Synchronizes user accounts with Supabase PostgreSQL.
   * If the Supabase users table is empty, seeds the default credentials.
   * If remote users exist, merges them into memory.
   */
  async syncWithDatabase(): Promise<void> {
    if (!isSupabaseConfigured()) return;
    const client = getSupabaseClient();
    if (!client) return;

    try {
      const { data, error } = await client.from("users").select("*");
      if (error) {
        console.warn("[UserStore] Supabase query notice:", error.message);
        return;
      }

      if (data && data.length > 0) {
        // Hydrate in-memory cache with persisted Supabase accounts
        for (const row of data as DbUser[]) {
          this.users.set(row.id, {
            id: row.id,
            email: row.email,
            role: row.role as UserRole,
            passwordHash: row.password_hash,
            salt: row.salt,
            createdAt: row.created_at,
            lastLoginAt: row.last_login_at,
            assignedRoom: row.assigned_room,
          });
        }
      } else {
        // Table is empty in freshly provisioned database: seed default accounts
        const seedPayload = Array.from(this.users.values()).map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          password_hash: u.passwordHash,
          salt: u.salt,
          assigned_room: u.assignedRoom,
          created_at: u.createdAt,
          updated_at: u.createdAt,
        }));
        await client.from("users").insert(seedPayload);
        await logAuditEventToDb({
          timestamp: new Date().toISOString(),
          actor_id: "system",
          actor_email: "system@energyguardian.ai",
          action: "SUPABASE_INITIAL_SEED",
          target_id: "users_table",
          target_type: "system",
          details: { seeded_user_count: seedPayload.length },
        });
      }
    } catch (err: any) {
      console.warn("[UserStore] Could not complete database sync:", err?.message || err);
    }
  }

  findByEmail(email: string): UserRecord | undefined {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === normalized) {
        return user;
      }
    }
    return undefined;
  }

  async findByEmailAsync(email: string): Promise<UserRecord | undefined> {
    const local = this.findByEmail(email);
    if (local || !isSupabaseConfigured()) return local;

    const client = getSupabaseClient();
    if (!client) return local;

    try {
      const { data, error } = await client
        .from("users")
        .select("*")
        .ilike("email", email.trim().toLowerCase())
        .limit(1);
      if (!error && data && data.length > 0) {
        const row = data[0] as DbUser;
        const user: UserRecord = {
          id: row.id,
          email: row.email,
          role: row.role as UserRole,
          passwordHash: row.password_hash,
          salt: row.salt,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
          assignedRoom: row.assigned_room,
        };
        this.users.set(user.id, user);
        return user;
      }
    } catch (_) {}
    return local;
  }

  findById(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  async findByIdAsync(id: string): Promise<UserRecord | undefined> {
    const local = this.findById(id);
    if (local || !isSupabaseConfigured()) return local;

    const client = getSupabaseClient();
    if (!client) return local;

    try {
      const { data, error } = await client.from("users").select("*").eq("id", id).limit(1);
      if (!error && data && data.length > 0) {
        const row = data[0] as DbUser;
        const user: UserRecord = {
          id: row.id,
          email: row.email,
          role: row.role as UserRole,
          passwordHash: row.password_hash,
          salt: row.salt,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
          assignedRoom: row.assigned_room,
        };
        this.users.set(user.id, user);
        return user;
      }
    } catch (_) {}
    return local;
  }

  createUser(email: string, password: string): UserRecord {
    const normalized = email.trim().toLowerCase();
    if (this.findByEmail(normalized)) {
      throw new Error("A user with this email already exists.");
    }

    const { hash, salt } = hashPassword(password);
    const user: UserRecord = {
      id: `usr_${randomBytes(6).toString("hex")}`,
      email: normalized,
      role: "occupant", // Normal people registering are strictly given the occupant/viewer role
      passwordHash: hash,
      salt,
      createdAt: new Date().toISOString(),
      assignedRoom: "Lab Classroom 101",
    };

    this.users.set(user.id, user);

    // Persist to Supabase asynchronously if configured
    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        Promise.resolve(
          client.from("users").insert([
            {
              id: user.id,
              email: user.email,
              role: user.role,
              password_hash: user.passwordHash,
              salt: user.salt,
              assigned_room: user.assignedRoom,
              created_at: user.createdAt,
              updated_at: user.createdAt,
            },
          ])
        )
          .then(({ error }: any) => {
            if (error) console.error("[UserStore] Failed to write user to Supabase:", error.message);
          })
          .catch((err: any) => console.error("[UserStore] Supabase insert error:", err));

        logAuditEventToDb({
          timestamp: new Date().toISOString(),
          actor_id: user.id,
          actor_email: user.email,
          action: "USER_REGISTERED",
          target_id: user.id,
          target_type: "user",
          details: { email: user.email, role: user.role },
        });
      }
    }

    return user;
  }

  async createUserAsync(email: string, password: string): Promise<UserRecord> {
    const existing = await this.findByEmailAsync(email);
    if (existing) {
      throw new Error("A user with this email already exists.");
    }

    const { hash, salt } = hashPassword(password);
    const user: UserRecord = {
      id: `usr_${randomBytes(6).toString("hex")}`,
      email: email.trim().toLowerCase(),
      role: "occupant",
      passwordHash: hash,
      salt,
      createdAt: new Date().toISOString(),
      assignedRoom: "Lab Classroom 101",
    };

    this.users.set(user.id, user);

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        const { error } = await client.from("users").insert([
          {
            id: user.id,
            email: user.email,
            role: user.role,
            password_hash: user.passwordHash,
            salt: user.salt,
            assigned_room: user.assignedRoom,
            created_at: user.createdAt,
            updated_at: user.createdAt,
          },
        ]);
        if (error) {
          throw new Error(`Failed to persist user to Supabase: ${error.message}`);
        }
        await logAuditEventToDb({
          timestamp: new Date().toISOString(),
          actor_id: user.id,
          actor_email: user.email,
          action: "USER_REGISTERED",
          target_id: user.id,
          target_type: "user",
          details: { email: user.email, role: user.role },
        });
      }
    }

    return user;
  }

  updateRole(id: string, newRole: UserRole, actor?: { id: string; email: string }): UserRecord {
    const user = this.users.get(id);
    if (!user) {
      throw new Error("User not found.");
    }
    user.role = newRole;
    this.users.set(id, user);

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        Promise.resolve(
          client
            .from("users")
            .update({ role: newRole, updated_at: new Date().toISOString() })
            .eq("id", id)
        )
          .then(({ error }: any) => {
            if (error) console.error("[UserStore] Failed to update role in Supabase:", error.message);
          })
          .catch((err: any) => console.error("[UserStore] Role update error:", err));

        logAuditEventToDb({
          timestamp: new Date().toISOString(),
          actor_id: actor?.id || "admin",
          actor_email: actor?.email || "admin@energyguardian.ai",
          action: "USER_ROLE_UPDATED",
          target_id: id,
          target_type: "user",
          details: { new_role: newRole, user_email: user.email },
        });
      }
    }

    return user;
  }

  async updateRoleAsync(id: string, newRole: UserRole, actor?: { id: string; email: string }): Promise<UserRecord> {
    const user = await this.findByIdAsync(id);
    if (!user) {
      throw new Error("User not found.");
    }
    user.role = newRole;
    this.users.set(id, user);

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        const { error } = await client
          .from("users")
          .update({ role: newRole, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) {
          throw new Error(`Failed to update role in Supabase: ${error.message}`);
        }
        await logAuditEventToDb({
          timestamp: new Date().toISOString(),
          actor_id: actor?.id || "admin",
          actor_email: actor?.email || "admin@energyguardian.ai",
          action: "USER_ROLE_UPDATED",
          target_id: id,
          target_type: "user",
          details: { new_role: newRole, user_email: user.email },
        });
      }
    }

    return user;
  }

  updatePassword(email: string, newPass: string): boolean {
    const user = this.findByEmail(email);
    if (!user) return false;
    const { hash, salt } = hashPassword(newPass);
    user.passwordHash = hash;
    user.salt = salt;
    this.users.set(user.id, user);

    if (isSupabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        Promise.resolve(
          client
            .from("users")
            .update({
              password_hash: hash,
              salt,
              updated_at: new Date().toISOString(),
            })
            .eq("id", user.id)
        ).catch((err: any) => console.error("[UserStore] Password update error:", err));
      }
    }
    return true;
  }

  recordLogin(id: string): void {
    const user = this.users.get(id);
    if (user) {
      const now = new Date().toISOString();
      user.lastLoginAt = now;
      this.users.set(id, user);

      if (isSupabaseConfigured()) {
        const client = getSupabaseClient();
        if (client) {
          Promise.resolve(
            client
              .from("users")
              .update({ last_login_at: now })
              .eq("id", id)
          ).catch(() => {});
        }
      }
    }
  }

  listUsers(): Array<Omit<UserRecord, "passwordHash" | "salt">> {
    return Array.from(this.users.values()).map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      assignedRoom: u.assignedRoom,
    }));
  }

  async listUsersAsync(): Promise<Array<Omit<UserRecord, "passwordHash" | "salt">>> {
    if (!isSupabaseConfigured()) return this.listUsers();
    const client = getSupabaseClient();
    if (!client) return this.listUsers();

    try {
      const { data, error } = await client
        .from("users")
        .select("id, email, role, created_at, last_login_at, assigned_room")
        .order("created_at", { ascending: false });
      if (!error && data) {
        return data.map((row: any) => ({
          id: row.id,
          email: row.email,
          role: row.role as UserRole,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
          assignedRoom: row.assigned_room,
        }));
      }
    } catch (_) {}
    return this.listUsers();
  }
}

export const userStore = new UserStore();

// Express Auth Middleware
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
    assignedRoom?: string;
  };
}

/**
 * Optional authentication middleware: if a token is present, resolves the user;
 * otherwise leaves req.user undefined.
 */
export function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }
  const token = authHeader.substring(7).trim();
  const payload = verifyToken(token);
  if (!payload) return next();

  const user = userStore.findById(payload.sub);
  if (user) {
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      assignedRoom: user.assignedRoom,
    };
  }
  next();
}

/**
 * Require valid authentication token.
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Authentication required. Missing Bearer token." });
    return;
  }

  const token = authHeader.substring(7).trim();
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ detail: "Invalid or expired authentication token." });
    return;
  }

  // Double check that user still exists and role matches server record
  const user = userStore.findById(payload.sub);
  if (!user) {
    res.status(401).json({ detail: "User account no longer exists." });
    return;
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: user.role, // Server-authoritative role
    assignedRoom: user.assignedRoom,
  };

  next();
}

/**
 * Require Admin role.
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin") {
      res.status(403).json({ detail: "Access denied: Administrative privileges required." });
      return;
    }
    next();
  });
}

/**
 * Require Operator or Admin role (for operational actions, troubleshooting, simulator controls).
 */
export function requireOperatorOrAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin" && req.user?.role !== "operator") {
      res.status(403).json({ detail: "Access denied: Facility operator or administrator privileges required." });
      return;
    }
    next();
  });
}
