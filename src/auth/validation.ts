// Pure sign-in form validation. Kept dependency-free so it is unit-testable in
// isolation and reusable by the sign-in form.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignInValues {
  email: string;
  password: string;
}

export interface SignInErrors {
  email?: string;
  password?: string;
}

/**
 * Validate the sign-in form. First-slice auth is username/password only, so the
 * rules are intentionally minimal: a well-formed email and a non-empty password.
 * Credential correctness is decided server-side by InsForge, not here.
 */
export function validateSignIn(values: SignInValues): SignInErrors {
  const errors: SignInErrors = {};
  const email = values.email.trim();

  if (!email) {
    errors.email = 'Enter your email address.';
  } else if (!EMAIL_RE.test(email)) {
    errors.email = "That doesn't look like a valid email.";
  }

  if (!values.password) {
    errors.password = 'Enter your password.';
  }

  return errors;
}

export function hasErrors(errors: SignInErrors): boolean {
  return Object.keys(errors).length > 0;
}
