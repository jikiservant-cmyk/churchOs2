export type SignupCredentialsResult =
  | { ok: true; email: string; password: string }
  | { ok: false; reason: 'email' | 'password' };

/** Validate credentials on the server; HTML input attributes are not trusted. */
export function validateSignupCredentials(emailValue: unknown, passwordValue: unknown): SignupCredentialsResult {
  if (typeof emailValue !== 'string') return { ok: false, reason: 'email' };
  if (typeof passwordValue !== 'string') return { ok: false, reason: 'password' };

  const email = emailValue.trim().normalize('NFKC').toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return { ok: false, reason: 'email' };
  }

  if (passwordValue.length < 8 || passwordValue.length > 256 || Buffer.byteLength(passwordValue, 'utf8') > 72) {
    return { ok: false, reason: 'password' };
  }

  return { ok: true, email, password: passwordValue };
}
