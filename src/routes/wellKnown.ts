import { Router, Request, Response } from "express";
import fs from "fs";
import { config } from "../config";

const router = Router();

/**
 * Tesla checks this URL to verify that the server operator controls the domain.
 * The path is fixed by the Tesla spec:
 *   GET /.well-known/appspecific/com.tesla.3p.public-key.pem
 */
router.get(
  "/.well-known/appspecific/com.tesla.3p.public-key.pem",
  (req: Request, res: Response) => {
    if (!fs.existsSync(config.keys.publicPath)) {
      res.status(503).send("Public key not found. Run: npm run generate-keys");
      return;
    }
    res.setHeader("Content-Type", "text/plain");
    res.sendFile(config.keys.publicPath);
  }
);

export default router;
