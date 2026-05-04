import { parse } from "dotenv";
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const envFile = join(root, ".env.vercel");

const SCOPE = process.env.VERCEL_SCOPE || "duckocancodes-projects";

const SENSITIVE = new Set(["SPOTIFY_CLIENT_SECRET"]);

const KEYS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REDIRECT_URI",
  "VITE_API",
  "VITE_API_BASE_URL",
];

if (!existsSync(envFile)) {
  console.error("Missing .env.vercel — copy fields from .env.example or create the file.");
  process.exit(1);
}

const parsed = parse(readFileSync(envFile, "utf8"));
const missing = [];

for (const key of KEYS) {
  const value = parsed[key]?.trim();
  if (!value) {
    missing.push(key);
    continue;
  }

  const args = [
    "vercel",
    "env",
    "add",
    key,
    "production",
    ...(SENSITIVE.has(key) ? ["--sensitive"] : []),
    "--value",
    value,
    "--yes",
    "--force",
    "--scope",
    SCOPE,
  ];

  // stdin ignored: chained npx on Windows can otherwise hang waiting for input
  const r = spawnSync("npx", args, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    shell: true,
  });
  if (r.status !== 0) {
    console.error(`Failed to set ${key}`);
    process.exit(r.status ?? 1);
  }
  console.log(`OK ${key}`);
}

if (missing.length) {
  console.error(`\nFill these in .env.vercel (empty): ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\nDone. Redeploy on Vercel so VITE_* is baked into the new build.");
