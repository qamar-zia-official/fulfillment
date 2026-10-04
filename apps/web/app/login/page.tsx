"use client";

import { useState } from "react";
import { authClient } from "../../lib/auth-client";
import styles from "../../components/operations-console.module.css";

/**
 * Sign-in.
 *
 * A client component because Better Auth's sign-in is a browser call, and because a form that
 * round-trips to the server to do this would need the session cookie readable by the server --
 * which it is not, and should not be.
 *
 * The error text distinguishes the two failures an operator will actually hit. "Invalid email or
 * password" is the one Better Auth returns for a wrong password *and* for an account that does
 * not exist, deliberately, so this form does not reintroduce the distinction by asking for the
 * password twice. What it does add is the network case, which is otherwise indistinguishable
 * from a wrong password and sends people to reset passwords that were fine.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const { error: signInError } = await authClient.signIn.email({ email: email.trim(), password });

    if (signInError) {
      setError(signInError.message ?? "Could not sign in.");
      setSubmitting(false);
      return;
    }

    // Full navigation rather than a client-side push: the console reads the session on mount, so
    // it has to be mounted *after* the cookie exists.
    window.location.assign("/exceptions");
  };

  return (
    <div className={styles.shell}>
      <div className={styles.signedOut}>
        <h1 className={styles.intro}>Sign in</h1>
        <p className={`${styles.noticeNeutral} ${styles.intro}`}>
          Operator accounts only. If you can sign in but see a refusal, your address is not on the operator list.
        </p>

        <form className={styles.form} onSubmit={submit}>
          <div className={styles.field}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className={styles.input}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className={styles.input}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error ? (
            <p className={styles.noticeError} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className={styles.button} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
