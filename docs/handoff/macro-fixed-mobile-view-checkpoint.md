# Fixed mobile Macro overview

Status: implementation candidate; verification and delivery pending.

The owner's latest correction supersedes PR812's adjustable overview: mobile
Macro should stay at 50%, with no Fit, plus, minus, percentage or zoom-help row.
Army, Workers, Supply, Income, Bank, APM and All stay on one compact row; narrow
screens can scroll that row horizontally. The original metric selection and
keyboard behavior remain.

The modal overview uses a fixed local transform. Its logical width follows twice
the available width, keeping the chart and both army columns inside the phone.
Logical roster targets are 48px so they remain 24px at 50%. Metric, bank,
supply-block and Close controls, and unit-detail portals, remain unscaled.
Dense content retains its reachable local scroll region. Desktop and full-game
views retain their existing sizing. Document zoom, viewport metadata, account
preferences and passive page scrolling are unchanged.

The former zoom-specific unit assertions are replaced to reflect the owner's
explicit removal of that feature. Selection, focus, orientation, late-data,
game-change, reopen, global-style and unsupported-observer coverage remain.
Modal close/navigation restoration tests are preserved. Browser geometry,
touch, keyboard, accessibility and production acceptance remain required.

Base: delivered main `dfe4d6234e9242bad9ff5d4a52ad2e36cbb7bc78`.
Cache: `C:/SC2TOOLS/.cache/macro-fixed-mobile-view-20261028`.
All original budgets and engine assets remain protected. No API, native-agent,
flag, provider or infrastructure change is part of this correction. The program
remains incomplete at 124 complete / 53 partial / 20 open (73 unfinished).
