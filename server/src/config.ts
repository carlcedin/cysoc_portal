// Central configuration, read once from environment variables.
// Every setting has a safe default for production; development overrides go in .env.

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}
const num = (name: string, fallback: number) => Number(env(name, String(fallback)));
const bool = (name: string, fallback: boolean) => env(name, String(fallback)).toLowerCase() === 'true';

export const config = {
  port: num('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
  databaseUrl: env('DATABASE_URL', 'postgres://portal_app@localhost:5432/cysoc_portal'),
  // 32 bytes, base64. Encrypts MFA secrets and integration credentials at rest.
  masterKey: env('MASTER_KEY', ''),
  cookieSecure: bool('COOKIE_SECURE', true),
  sessionIdleMinutes: num('SESSION_IDLE_MINUTES', 30),
  sessionMaxHours: num('SESSION_MAX_HOURS', 12),
  loginMaxFailures: num('LOGIN_MAX_FAILURES', 5),
  loginLockMinutes: num('LOGIN_LOCK_MINUTES', 15),
  storageDir: env('STORAGE_DIR', './data/reports'),
  uploadMaxMb: num('UPLOAD_MAX_MB', 50),
  clamavHost: env('CLAMAV_HOST', ''),
  clamavPort: num('CLAMAV_PORT', 3310),
  syslogHost: env('SYSLOG_HOST', ''),
  syslogPort: num('SYSLOG_PORT', 514),
  syslogProtocol: env('SYSLOG_PROTOCOL', 'udp') as 'udp' | 'tcp',
  // 'live' calls NTS and Grafana; 'demo' generates sample data so the portal can be evaluated without integrations.
  integrationMode: env('INTEGRATION_MODE', 'live') as 'live' | 'demo',
  workerIntervalSeconds: num('WORKER_INTERVAL_SECONDS', 60),
  webDir: env('WEB_DIR', './dist/web'),
  trustProxy: bool('TRUST_PROXY', true),
};

export function masterKeyBytes(): Buffer {
  if (!config.masterKey) throw new Error('MASTER_KEY is not set. Generate one with: openssl rand -base64 32');
  const key = Buffer.from(config.masterKey, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64 encoded');
  return key;
}
