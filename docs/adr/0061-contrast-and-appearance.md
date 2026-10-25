# ADR0061: contrast roles and explicit appearance modes

Status: accepted for implementation.

Shared accent and danger colors served both text and white-label button fills,
which require different luminance on dark surfaces. Light semantic labels and
control boundaries also needed measurable contrast. The saved theme lacked an
explicit System mode, while CSS documentation no longer matched the product.

Keep fill tokens and add independent accent ink/danger-fill roles through the
existing Tailwind utilities. Measure text on the three main surfaces, white on
control fills and control boundaries in both themes and a dark replay nested
inside Light. One matrix generates the contributor contrast table and tests.

Keep resolved Theme as light/dark and store ThemeMode as light/dark/system.
One shared subscription follows OS changes only for System, synchronizes tabs
and runtime theme-color, and shares its value space with the pre-paint script.
Use existing Modal for richer appearance options and supported Clerk actions.

Public-page axe checks run in both themes at all existing viewports, with exact
reviewed exceptions rather than disabled rules. Keyboard and manual visual
checks supplement automation. The accessibility statement describes a target
and known limits; it does not claim complete conformance from an automated run.

No account preference, backend service, integration, infrastructure, release or
bundle-budget increase is introduced. Persisted Light/Dark choices stay valid;
missing/invalid choices follow System without an automatic storage write.
