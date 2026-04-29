/**
 * On Railway (and any environment where keys/ is not on disk),
 * write the PEM files from environment variables at startup.
 *
 * Set these in Railway's environment variable dashboard:
 *   PRIVATE_KEY_CONTENT  – full contents of keys/private.pem
 *   PUBLIC_KEY_CONTENT   – full contents of keys/public.pem
 */

import fs from "fs";
import path from "path";

export function initKeysFromEnv() {
  const privateContent = process.env.PRIVATE_KEY_CONTENT;
  const publicContent = process.env.PUBLIC_KEY_CONTENT;

  if (!privateContent && !publicContent) return; // using local files, nothing to do

  const keysDir = path.resolve("keys");
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

  if (privateContent) {
    const dest = path.join(keysDir, "private.pem");
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, privateContent.replace(/\\n/g, "\n"), { mode: 0o600 });
      console.log("[Keys] Wrote private.pem from PRIVATE_KEY_CONTENT env var");
    }
  }

  if (publicContent) {
    const dest = path.join(keysDir, "public.pem");
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, publicContent.replace(/\\n/g, "\n"), { mode: 0o644 });
      console.log("[Keys] Wrote public.pem from PUBLIC_KEY_CONTENT env var");
    }
  }
}
