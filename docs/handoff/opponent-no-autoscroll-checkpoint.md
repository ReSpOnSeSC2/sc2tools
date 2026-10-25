# Opponent analysis keeps the reading position

The phase tabs previously called `scrollIntoView` in their active-phase effect,
including the first mount after a delayed opponent analysis response. Browser
scrolling included the document, so the reader was moved to Recorded compositions.
SectionNav used the same ancestor-scrolling API after scroll-spy updates.

Both passive paths now reveal chips through their own container's horizontal
scroll position. Keyboard phase focus uses `preventScroll`; explicit SectionNav
clicks retain their existing target scroll, hash and reduced-motion behavior.
No opponent section is reordered: Brief, Tendencies, Timings, History, Ladder,
Identity remain in the current live order. Replay history stays above notes.

The actual-source browser fixture reproduces a 0→1521px jump before the change.
It now passes 53 checks at320/390/768/1440 in both themes: delayed mount preserves
viewport/focus, explicit navigation works, phase keyboard navigation stays in
place and phone strips reveal their active tab horizontally. Every nonlocal
request is blocked and there are no API writes. Both added unit regressions
failed before the fix; all42 focused phase/navigation/profile assertions pass.

Final types, strict changed-source lint, production build/budgets, independent
review and exact-head remote gates are recorded in the PR before merge. No
engine/native/API, provider, production-data, integration, version, release or
infrastructure/budget change accompanies this fix.
