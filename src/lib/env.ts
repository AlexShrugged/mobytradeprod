// "Prod runtime" = any Vercel deployment, production or preview. Local dev
// and local `next build` keep the zero-env conveniences (PGlite, stub
// processors, open admin); anything running on Vercel must fail closed
// instead of silently degrading to a stub. Keyed on VERCEL rather than
// NODE_ENV because `next build` sets NODE_ENV=production locally too.
export function isProdRuntime(): boolean {
  return process.env.VERCEL === "1";
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required when running on Vercel — set it in the project environment.`,
    );
  }
  return value;
}
