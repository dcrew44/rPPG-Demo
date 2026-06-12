// Copies the @mediapipe/tasks-vision WASM runtime out of node_modules into
// public/wasm (gitignored), so the app serves it itself — no CDN at runtime —
// and the runtime can never version-skew against the installed package.
// Runs automatically before `npm run dev` and `npm run build`.

import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = join(root, "public", "wasm");

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
