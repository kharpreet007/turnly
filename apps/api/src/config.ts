export interface Config {
  databaseUrl: string;
  port: number;
  appSecret: string;
  verifyToken: string;
  adminToken: string;
  allowedOrigins: string[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing env var ${k}`);
    return v;
  };
  return {
    databaseUrl: need('DATABASE_URL'),
    port: Number(env.PORT ?? 3000),
    appSecret: need('META_APP_SECRET'),
    verifyToken: need('META_VERIFY_TOKEN'),
    adminToken: need('ADMIN_TOKEN'),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
