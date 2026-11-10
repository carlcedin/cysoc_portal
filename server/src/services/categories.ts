// CySOC customer categories (service lines). Order is the order shown in the portal.
export const CATEGORIES = [
  { code: 'TSAM', name: 'TIME Security Advanced Monitoring' },
  { code: 'TMDR', name: 'TIME Managed Detect & Response' },
  { code: 'DDoS', name: 'DDoS detection and alerting' },
  { code: 'TSN', name: 'TIME Secure Network' },
  { code: 'TSN+', name: 'TIME Secure Network Plus' },
  { code: 'VA', name: 'Vulnerability assessment' },
  { code: 'PAM', name: 'Managed PAM' },
] as const;
export const CATEGORY_CODES: readonly string[] = CATEGORIES.map(c => c.code);
