import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startIsolatedTestServer, IsolatedTestServer } from "./test_helper.js";
import {
  userStore,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
} from "../src/auth.js";

let testServer: IsolatedTestServer;
let API_BASE = "";

before(async () => {
  testServer = await startIsolatedTestServer();
  API_BASE = testServer.baseUrl;
});

after(async () => {
  if (testServer) {
    await testServer.close();
  }
});

async function postJson(url: string, data: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchJson(url: string, data: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("Password Hashing & Verification Security", () => {
  const pass = "ComplexSecurePass!2026";
  const { hash, salt } = hashPassword(pass);
  assert.ok(hash.length > 32);
  assert.ok(salt.length > 16);
  assert.equal(verifyPassword(pass, hash, salt), true);
  assert.equal(verifyPassword("WrongPassword123", hash, salt), false);
});

test("JWT Token Lifecycle & Expiration", () => {
  const token = signToken({ sub: "usr_test_123", email: "test@energyguardian.ai", role: "user" }, 60);
  const payload = verifyToken(token);
  assert.ok(payload);
  assert.equal(payload.email, "test@energyguardian.ai");
  assert.equal(payload.role, "user");

  // Tampered token fails
  const tampered = token.slice(0, -5) + "abcde";
  assert.equal(verifyToken(tampered), null);

  // Expired token
  const expiredToken = signToken({ sub: "usr_test_expired", email: "expired@test.ai", role: "user" }, -1);
  assert.equal(verifyToken(expiredToken), null);
});

test("Successful Admin and Normal User Authentication via API", async () => {
  const adminRes = await postJson("/api/auth/login", {
    email: "admin@energyguardian.ai",
    password: "AdminGuardian2026!",
  });
  assert.equal(adminRes.status, 200);
  assert.ok(adminRes.body.token);
  assert.equal(adminRes.body.user.role, "admin");

  const userRes = await postJson("/api/auth/login", {
    email: "user@energyguardian.ai",
    password: "UserGuardian2026!",
  });
  assert.equal(userRes.status, 200);
  assert.ok(userRes.body.token);
  assert.equal(userRes.body.user.role, "occupant");
});

test("Authentication Rejections on Bad Credentials", async () => {
  const res = await postJson("/api/auth/login", {
    email: "admin@energyguardian.ai",
    password: "IncorrectPassword123!",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.detail, "Invalid email or password.");
});

test("Protected Endpoints reject missing or invalid tokens", async () => {
  const noToken = await getJson("/api/auth/me");
  assert.equal(noToken.status, 401);

  const badToken = await getJson("/api/auth/me", "invalid.jwt.token");
  assert.equal(badToken.status, 401);
});

test("Normal User Access vs Admin-Restricted Endpoints (RBAC Enforced Server-Side)", async () => {
  const userLogin = await postJson("/api/auth/login", {
    email: "user@energyguardian.ai",
    password: "UserGuardian2026!",
  });
  const userToken = userLogin.body.token;

  // Normal user CAN view self
  const meRes = await getJson("/api/auth/me", userToken);
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.user.role, "occupant");

  // Normal user CANNOT access admin users list
  const adminUsers = await getJson("/api/admin/users", userToken);
  assert.equal(adminUsers.status, 403);
  assert.match(adminUsers.body.detail, /Administrative privileges required/i);

  // Normal user CANNOT access admin stats
  const adminStats = await getJson("/api/admin/stats", userToken);
  assert.equal(adminStats.status, 403);

  // Normal user CANNOT access admin audit logs
  const adminAudit = await getJson("/api/admin/audit-logs", userToken);
  assert.equal(adminAudit.status, 403);

  // Normal user CANNOT access admin ml status or settings
  const adminMl = await getJson("/api/admin/ml-status", userToken);
  assert.equal(adminMl.status, 403);

  const adminSet = await getJson("/api/admin/settings", userToken);
  assert.equal(adminSet.status, 403);

  // Normal user CANNOT run simulator
  const simRes = await postJson("/simulator/run", { count: 1 }, userToken);
  assert.equal(simRes.status, 403);

  // Normal user CANNOT access technical hardware diagnostics
  const diagRes = await getJson("/api/diagnostics", userToken);
  assert.equal(diagRes.status, 403);
});

test("Facility Operator Authentication and Role Privileges", async () => {
  const opLogin = await postJson("/api/auth/login", {
    email: "operator@energyguardian.ai",
    password: "OperatorGuardian2026!",
  });
  assert.equal(opLogin.status, 200);
  const opToken = opLogin.body.token;
  assert.equal(opLogin.body.user.role, "operator");

  // Operator CAN access diagnostics
  const diagRes = await getJson("/api/diagnostics", opToken);
  assert.equal(diagRes.status, 200);
  assert.equal(diagRes.body.role, "operator");
  // Operator does NOT get admin internal details
  assert.equal(diagRes.body.admin_details, undefined);

  // Operator CAN run simulator for troubleshooting
  const simRes = await postJson("/simulator/run", { count: 1 }, opToken);
  assert.equal(simRes.status, 200);
  assert.equal(simRes.body.label, "SIMULATED DATA");

  // Operator CANNOT manage roles or view user accounts
  const usersRes = await getJson("/api/admin/users", opToken);
  assert.equal(usersRes.status, 403);

  // Operator CANNOT access admin audit logs, ml-status, or settings
  const auditRes = await getJson("/api/admin/audit-logs", opToken);
  assert.equal(auditRes.status, 403);

  const mlRes = await getJson("/api/admin/ml-status", opToken);
  assert.equal(mlRes.status, 403);

  const setRes = await getJson("/api/admin/settings", opToken);
  assert.equal(setRes.status, 403);
});

test("Admin Access to Administrative Endpoints & System Audit", async () => {
  const adminLogin = await postJson("/api/auth/login", {
    email: "admin@energyguardian.ai",
    password: "AdminGuardian2026!",
  });
  const adminToken = adminLogin.body.token;

  const usersRes = await getJson("/api/admin/users", adminToken);
  assert.equal(usersRes.status, 200);
  assert.ok(Array.isArray(usersRes.body.users));

  const statsRes = await getJson("/api/admin/stats", adminToken);
  assert.equal(statsRes.status, 200);
  assert.ok(statsRes.body.totalUsers >= 3);

  const auditRes = await getJson("/api/admin/audit-logs", adminToken);
  assert.equal(auditRes.status, 200);
  assert.ok(Array.isArray(auditRes.body.audit_logs));

  const mlRes = await getJson("/api/admin/ml-status", adminToken);
  assert.equal(mlRes.status, 200);
  assert.ok(Array.isArray(mlRes.body.models));
  assert.ok(mlRes.body.training_baseline.record_count === 1131);

  const settingsRes = await getJson("/api/admin/settings", adminToken);
  assert.equal(settingsRes.status, 200);
  assert.equal(settingsRes.body.configured_device_id, "ESP32_LAB_CLASSROOM_01");

  const diagRes = await getJson("/api/diagnostics", adminToken);
  assert.equal(diagRes.status, 200);
  assert.ok(diagRes.body.admin_details);
});

test("Client Role Escalation Prevention on Registration", async () => {
  const randomEmail = `hacker_${Date.now()}@energyguardian.ai`;
  const regRes = await postJson("/api/auth/register", {
    email: randomEmail,
    password: "AttackPassword123!",
    role: "admin", // Attempt to self-promote
  });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.body.user.role, "occupant"); // Must default to occupant
});

test("Admin Role Management across Admin, Operator, Occupant", async () => {
  const adminLogin = await postJson("/api/auth/login", {
    email: "admin@energyguardian.ai",
    password: "AdminGuardian2026!",
  });
  const adminToken = adminLogin.body.token;

  const usersRes = await getJson("/api/admin/users", adminToken);
  const targetUser = usersRes.body.users.find((u: any) => u.email === "student@energyguardian.ai");
  assert.ok(targetUser);

  // Promote student to operator
  const promoteRes = await patchJson(`/api/admin/users/${targetUser.id}/role`, { role: "operator" }, adminToken);
  assert.equal(promoteRes.status, 200);
  assert.equal(promoteRes.body.user.role, "operator");

  // Revert back to occupant
  const demoteRes = await patchJson(`/api/admin/users/${targetUser.id}/role`, { role: "occupant" }, adminToken);
  assert.equal(demoteRes.status, 200);
  assert.equal(demoteRes.body.user.role, "occupant");

  // Admin cannot assign an invalid role
  const badRoleRes = await patchJson(`/api/admin/users/${targetUser.id}/role`, { role: "superadmin" }, adminToken);
  assert.equal(badRoleRes.status, 400);
});

test("Operator Role Privilege Escalation Prevention", async () => {
  const opLogin = await postJson("/api/auth/login", {
    email: "operator@energyguardian.ai",
    password: "OperatorGuardian2026!",
  });
  const opToken = opLogin.body.token;

  // Operator attempts to grant themselves admin privileges
  const selfPromote = await patchJson(`/api/admin/users/${opLogin.body.user.id}/role`, { role: "admin" }, opToken);
  assert.equal(selfPromote.status, 403);
  assert.match(selfPromote.body.detail, /Administrative privileges required/i);

  // Operator attempts to modify another user's role
  const otherPromote = await patchJson("/api/admin/users/usr_occupant_003/role", { role: "admin" }, opToken);
  assert.equal(otherPromote.status, 403);
});

test("Classroom Occupant Unauthorized Access Rejection on All Protected Endpoints", async () => {
  const occLogin = await postJson("/api/auth/login", {
    email: "student@energyguardian.ai",
    password: "StudentGuardian2026!",
  });
  const occToken = occLogin.body.token;

  // Occupant cannot change roles
  const roleRes = await patchJson("/api/admin/users/usr_occupant_003/role", { role: "admin" }, occToken);
  assert.equal(roleRes.status, 403);

  // Occupant cannot run simulator
  const simRun = await postJson("/simulator/run", { count: 1 }, occToken);
  assert.equal(simRun.status, 403);

  // Occupant cannot toggle continuous simulator
  const simToggle = await postJson("/simulator/toggle", { enabled: true }, occToken);
  assert.equal(simToggle.status, 403);

  // Occupant cannot view diagnostics
  const diagRes = await getJson("/api/diagnostics", occToken);
  assert.equal(diagRes.status, 403);

  // Occupant cannot access admin routes
  const adminUsers = await getJson("/api/admin/users", occToken);
  assert.equal(adminUsers.status, 403);
});

test("Unauthenticated Requests to Protected Endpoints Return 401 Unauthorized", async () => {
  assert.equal((await getJson("/api/admin/users")).status, 401);
  assert.equal((await getJson("/api/admin/stats")).status, 401);
  assert.equal((await getJson("/api/admin/audit-logs")).status, 401);
  assert.equal((await getJson("/api/admin/ml-status")).status, 401);
  assert.equal((await getJson("/api/admin/settings")).status, 401);
  assert.equal((await getJson("/api/diagnostics")).status, 401);
  assert.equal((await postJson("/simulator/run", {})).status, 401);
  assert.equal((await postJson("/simulator/toggle", {})).status, 401);
  assert.equal((await patchJson("/api/admin/users/usr_admin_001/role", { role: "occupant" })).status, 401);
});

test("Room Scoping by Role: Admin Sees All Rooms, Operator & Occupant See Assigned Only", async () => {
  const adminLogin = await postJson("/api/auth/login", { email: "admin@energyguardian.ai", password: "AdminGuardian2026!" });
  const opLogin = await postJson("/api/auth/login", { email: "operator@energyguardian.ai", password: "OperatorGuardian2026!" });
  const occLogin = await postJson("/api/auth/login", { email: "student@energyguardian.ai", password: "StudentGuardian2026!" });

  // Admin sees all 3 rooms
  const adminRooms = await getJson("/api/rooms", adminLogin.body.token);
  assert.equal(adminRooms.status, 200);
  assert.equal(adminRooms.body.access_level, "all_rooms");
  assert.equal(adminRooms.body.rooms.length, 3);

  // Operator sees only assigned room
  const opRooms = await getJson("/api/rooms", opLogin.body.token);
  assert.equal(opRooms.status, 200);
  assert.equal(opRooms.body.access_level, "assigned_only");
  assert.equal(opRooms.body.rooms.length, 1);
  assert.equal(opRooms.body.rooms[0].name, "Lab Classroom 101");

  // Occupant sees only assigned room
  const occRooms = await getJson("/api/rooms", occLogin.body.token);
  assert.equal(occRooms.status, 200);
  assert.equal(occRooms.body.access_level, "assigned_only");
  assert.equal(occRooms.body.rooms.length, 1);
  assert.equal(occRooms.body.rooms[0].name, "Lab Classroom 101");

  // Unauthenticated guest sees only assigned room
  const guestRooms = await getJson("/api/rooms");
  assert.equal(guestRooms.status, 200);
  assert.equal(guestRooms.body.access_level, "assigned_only");
  assert.equal(guestRooms.body.rooms.length, 1);
});

