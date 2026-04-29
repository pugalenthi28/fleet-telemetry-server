/**
 * Generates an EC P-256 key pair for Tesla Fleet API registration.
 *
 * Tesla requires the prime256v1 (P-256 / secp256r1) curve.
 * Private key → keys/private.pem  (keep secret – never commit)
 * Public key  → keys/public.pem   (served at /.well-known/appspecific/com.tesla.3p.public-key.pem)
 *
 * Usage:  npm run generate-keys
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const KEYS_DIR = path.resolve(__dirname, "../keys");
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, "private.pem");
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, "public.pem");

function main() {
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
  }

  if (fs.existsSync(PRIVATE_KEY_PATH) || fs.existsSync(PUBLIC_KEY_PATH)) {
    console.log("⚠️  Key files already exist:");
    console.log("   ", PRIVATE_KEY_PATH);
    console.log("   ", PUBLIC_KEY_PATH);
    console.log("\nDelete them manually if you want to regenerate.");
    process.exit(0);
  }

  console.log("Generating EC P-256 key pair…");

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644 });

  console.log("✅  Keys generated:");
  console.log("    Private →", PRIVATE_KEY_PATH, "(chmod 600, keep secret)");
  console.log("    Public  →", PUBLIC_KEY_PATH);
  console.log();
  console.log("Next steps:");
  console.log("  1. Start the server: npm run dev");
  console.log("  2. Start ngrok and note the HTTPS URL");
  console.log("  3. Verify the public key is accessible:");
  console.log("     curl https://<ngrok-url>/.well-known/appspecific/com.tesla.3p.public-key.pem");
  console.log("  4. Register the URL in the Tesla Developer Portal");
  console.log("     → https://developer.tesla.com/en_US/dashboard");
}

main();
