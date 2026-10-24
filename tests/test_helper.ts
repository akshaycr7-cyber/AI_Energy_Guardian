/**
 * Isolated Test Server & Persistence Safety Helper
 *
 * Ensures automated tests:
 * 1. Never send HTTP requests to the live server on port 3000.
 * 2. Never connect or write to the production Supabase project (nor require a second Supabase project).
 * 3. Use isolated in-memory storage and deterministic mock clients only.
 * 4. Fail fast with an explicit error if test isolation cannot be guaranteed.
 * 5. Provide explicit test-only ESP32_SECRET and JWT_SECRET credentials.
 */

process.env.AEG_TEST_MODE = "1";

export const TEST_ESP32_SECRET = "test_only_esp32_secret_guardian_2026";
export const TEST_JWT_SECRET = "test_only_jwt_secret_guardian_2026";
export const TEST_DEVICE_ID = "ESP32_LAB_CLASSROOM_01";

process.env.ESP32_SECRET = TEST_ESP32_SECRET;
process.env.JWT_SECRET = TEST_JWT_SECRET;

export const ESP32_AUTH_HEADERS: Record<string, string> = {
  "x-device-id": TEST_DEVICE_ID,
  "x-device-secret": TEST_ESP32_SECRET,
  "x-sensor-source": "esp32",
};

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../server.js";
import { setContinuousSimulator } from "../src/simulator.js";
import {
  getSupabaseClient,
  getSupabaseConfig,
  isAutomatedTestEnv,
  isMockClientOverrideActive,
  isSupabaseConfigured,
  setSupabaseClientForTesting,
} from "../src/supabase.js";

export interface IsolatedTestServer {
  baseUrl: string;
  port: number;
  server: http.Server;
  close: () => Promise<void>;
}

/**
 * Verifies that automated test execution is strictly isolated from external Supabase projects.
 * Throws immediately with an actionable message if isolation cannot be guaranteed.
 */
export function assertTestDatabaseIsolation(): void {
  if (!isAutomatedTestEnv()) {
    throw new Error(
      "Test isolation failure: Automated test environment flag is not active. Refusing to run tests against potentially live persistence."
    );
  }

  if (getSupabaseConfig() !== null) {
    throw new Error(
      "Test isolation failure: External Supabase configuration resolved during automated test mode. Tests must use in-memory or mock storage only."
    );
  }

  if (!isMockClientOverrideActive()) {
    if (isSupabaseConfigured() || getSupabaseClient() !== null) {
      throw new Error(
        "Test isolation failure: Active Supabase client detected without an explicit test mock override."
      );
    }
  }
}

/**
 * Starts an in-process Express server bound to 127.0.0.1 on an ephemeral port (!== 3000)
 * backed by isolated in-memory persistence unless a test explicitly injects a mock client.
 */
export async function startIsolatedTestServer(): Promise<IsolatedTestServer> {
  process.env.AEG_TEST_MODE = "1";
  process.env.ESP32_SECRET = TEST_ESP32_SECRET;
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  setSupabaseClientForTesting(null);
  assertTestDatabaseIsolation();

  const server = await new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    srv.once("error", reject);
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== "number") {
    server.close();
    throw new Error("Test isolation failure: Could not determine ephemeral test server port.");
  }

  if (addr.port === 3000) {
    server.close();
    throw new Error("Test isolation failure: Test server bound to live port 3000. Aborting to protect live server.");
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    server,
    close: async () => {
      setContinuousSimulator(false);
      setSupabaseClientForTesting(null);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
