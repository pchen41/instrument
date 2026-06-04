/* ============================================================================
   Instrument — Auth (signup / login) — interactive React
   A single card that toggles between Sign in and Create account.
   Three visual variations share one fully working form (validation, password
   show/hide + strength, submit/loading, success, and credential-error states).
   ========================================================================== */

const { useState, useRef, useEffect } = React;

/* ---- inline-SVG icon helper (uses the Instrument icon layer) ------------- */
function Icon({ name, style }) {
  const html = (window.Instrument && window.Instrument.iconHTML(name)) || "";
  return <i className="ic" style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ---- validation ---------------------------------------------------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function strengthOf(pw) {
  if (!pw) return { score: 0, label: "", cls: "" };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  const map = [
    { label: "Too short", cls: "s-weak" },
    { label: "Weak", cls: "s-weak" },
    { label: "Fair", cls: "s-fair" },
    { label: "Good", cls: "s-good" },
    { label: "Strong", cls: "s-strong" },
  ];
  return { score: s, ...map[s] };
}

/* ---- a single text field with inline validation -------------------------- */
function Field({ id, label, type, value, onChange, placeholder, error, autoComplete,
                 right, trailing, onFocus, onBlur, focused }) {
  return (
    <div className="field">
      {(label || right) && (
        <div className="field-top">
          {label && <label htmlFor={id}>{label}</label>}
          {right}
        </div>
      )}
      <div className={"control" + (focused ? " is-focus" : "") + (error ? " is-error" : "")}>
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
        />
        {trailing}
      </div>
      {error && (
        <div className="field-msg">
          <Icon name="warning" /><span>{error}</span>
        </div>
      )}
    </div>
  );
}

/* ---- the shared, fully-working form -------------------------------------- */
function AuthCore({ mode, setMode }) {
  const isSignup = mode === "signup";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);   // attempted submit
  const [focus, setFocus] = useState(null);
  const [status, setStatus] = useState("idle");          // idle | loading | done
  const [formError, setFormError] = useState("");

  // reset transient state when the mode flips
  useEffect(() => {
    setTouched({}); setSubmitted(false); setFormError(""); setStatus("idle");
    setConfirm(""); setShowPw(false);
  }, [mode]);

  // on success, continue into the console
  useEffect(() => {
    if (status !== "done") return;
    const t = window.setTimeout(() => { window.location.href = "Console.html"; }, 1500);
    return () => window.clearTimeout(t);
  }, [status]);

  const strength = strengthOf(password);

  function errorsFor() {
    const e = {};
    if (!email) e.email = "Enter your email address.";
    else if (!EMAIL_RE.test(email)) e.email = "That doesn't look like a valid email.";

    if (!password) e.password = "Enter your password.";
    else if (isSignup && password.length < 8) e.password = "Use at least 8 characters.";

    if (isSignup) {
      if (!name.trim()) e.name = "Tell us your name.";
      if (!confirm) e.confirm = "Re-enter your password.";
      else if (confirm !== password) e.confirm = "Passwords don't match.";
    }
    return e;
  }
  const errs = errorsFor();
  const show = (k) => (submitted || touched[k]) && errs[k];

  function blur(k) {
    setTouched((t) => ({ ...t, [k]: true }));
    setFocus(null);
  }

  function submit(ev) {
    ev.preventDefault();
    setFormError("");
    setSubmitted(true);
    if (Object.keys(errs).length) return;

    setStatus("loading");
    // simulate the round-trip
    window.setTimeout(() => {
      // demo: a short sign-in password is treated as a wrong credential
      if (!isSignup && password.length < 6) {
        setStatus("idle");
        setFormError("Email or password is incorrect.");
        return;
      }
      setStatus("done");
    }, 1300);
  }

  if (status === "done") {
    return (
      <div className="auth-success">
        <div className="ok-badge"><Icon name="check-circle" /></div>
        <h3>{isSignup ? "Account created" : "Signed in"}</h3>
        <p>
          {isSignup
            ? "Workspace ready. Connect an observability source to get started."
            : "Welcome back. Instrument is watching your services."}
        </p>
        <div className="settle">
          <span className="spinner" />
          <span>Opening the console…</span>
        </div>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {formError && (
        <div className="auth-alert">
          <Icon name="critical" />
          <span>{formError} <strong>Check your details and try again.</strong></span>
        </div>
      )}

      {isSignup && (
        <Field id="name" label="Name" type="text" value={name} onChange={setName}
               placeholder="Ada Lovelace" autoComplete="name" error={show("name") ? errs.name : ""}
               focused={focus === "name"} onFocus={() => setFocus("name")} onBlur={() => blur("name")} />
      )}

      <Field id="email" label="Work email" type="email" value={email} onChange={setEmail}
             placeholder="you@company.com" autoComplete="email" error={show("email") ? errs.email : ""}
             focused={focus === "email"} onFocus={() => setFocus("email")} onBlur={() => blur("email")} />

      <Field
        id="password"
        label="Password"
        type={showPw ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder={isSignup ? "At least 8 characters" : "Your password"}
        autoComplete={isSignup ? "new-password" : "current-password"}
        error={show("password") ? errs.password : ""}
        focused={focus === "password"}
        onFocus={() => setFocus("password")}
        onBlur={() => blur("password")}
        right={!isSignup ? <span className="hintlink">Forgot password?</span> : null}
        trailing={
          <button type="button" className="pw-toggle"
                  onClick={() => setShowPw((v) => !v)} tabIndex={-1}
                  aria-label={showPw ? "Hide password" : "Show password"}>
            {showPw ? "Hide" : "Show"}
          </button>
        }
      />

      {isSignup && password && !show("password") && (
        <div className={"pw-strength " + strength.cls}>
          <div className="pw-bars"><span /><span /><span /><span /></div>
          <span className="pw-label">Password strength · {strength.label}</span>
        </div>
      )}

      {isSignup && (
        <Field id="confirm" label="Confirm password" type={showPw ? "text" : "password"}
               value={confirm} onChange={setConfirm} placeholder="Re-enter password"
               autoComplete="new-password" error={show("confirm") ? errs.confirm : ""}
               focused={focus === "confirm"} onFocus={() => setFocus("confirm")} onBlur={() => blur("confirm")} />
      )}

      <button type="submit" className="auth-submit" disabled={status === "loading"}>
        {status === "loading"
          ? <><span className="spinner" /> {isSignup ? "Creating account…" : "Signing in…"}</>
          : <>{isSignup ? "Create account" : "Sign in"} <Icon name="arrow-right" /></>}
      </button>

      {isSignup && (
        <p className="legal">
          By creating an account you agree to Instrument's <a href="#">Terms</a> and{" "}
          <a href="#">Privacy Policy</a>.
        </p>
      )}
    </form>
  );
}

/* ---- footer toggle line (shared) ----------------------------------------- */
function FootToggle({ mode, setMode }) {
  const isSignup = mode === "signup";
  return (
    <div className="auth-foot">
      {isSignup ? "Already have an account? " : "New to Instrument? "}
      <button className="linkbtn" onClick={() => setMode(isSignup ? "signin" : "signup")}>
        {isSignup ? "Sign in" : "Create an account"}
      </button>
    </div>
  );
}

/* ========================================================================== */
/* VARIATION A — Minimal                                                      */
/* ========================================================================== */
function AuthMinimal() {
  const [mode, setMode] = useState("signin");
  const isSignup = mode === "signup";
  return (
    <div className="auth-stage">
      <div className="auth-card">
        <div className="auth-body">
          <div className="auth-brand">
            <img src="assets/logo-mark.svg" alt="" />
            <span className="wm">Instrument</span>
          </div>
          <h1 className="auth-title">{isSignup ? "Create your account" : "Sign in"}</h1>
          <p className="auth-sub">
            {isSignup
              ? "Set up your Instrument workspace in a moment."
              : "Welcome back to your workspace."}
          </p>
          <AuthCore mode={mode} setMode={setMode} />
        </div>
        <FootToggle mode={mode} setMode={setMode} />
      </div>
    </div>
  );
}

/* ========================================================================== */
/* App                                                                        */
/* ========================================================================== */
function App() {
  return <AuthMinimal />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
