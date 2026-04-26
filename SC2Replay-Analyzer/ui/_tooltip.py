"""Lightweight hover tooltip for Tk / CustomTkinter widgets.

The Opponents-tab timing cards use this to surface min/max/last-seen
metadata on hover without dragging in a heavier dialog framework.
The tooltip is rendered as a borderless ``Toplevel`` so it can escape
the parent's clipping rectangle and stays put for the lifetime of the
hover.

Usage::

    from ui._tooltip import Tooltip

    Tooltip(my_widget, text="range 3:14 - 4:02\nlast seen at 3:48")

The tooltip cleans itself up on ``<Leave>`` and on any mouse press, so
it never stacks if the user clicks through to the click handler. Update
the text dynamically with :meth:`update_text` (e.g. when the underlying
sample changes).
"""

from __future__ import annotations

import tkinter as tk
from typing import Optional


class Tooltip:
    """Hover tooltip attached to a single widget.

    Parameters
    ----------
    widget:
        Any Tk / CTk widget. Must be packed/gridded *before* the tooltip
        is constructed so :meth:`winfo_rootx` / :meth:`winfo_rooty` work.
    text:
        Multi-line string to display. Empty strings hide the tooltip
        entirely (we don't show a 0x0 popup).
    delay_ms:
        Milliseconds to wait after ``<Enter>`` before showing the tip.
        Matches the Win10/macOS feel; tweaks should stay small.
    """

    def __init__(
        self,
        widget: tk.Misc,
        text: str = "",
        delay_ms: int = 350,
    ) -> None:
        self._widget = widget
        self._text = text or ""
        self._delay_ms = max(0, int(delay_ms))
        self._after_id: Optional[str] = None
        self._tip: Optional[tk.Toplevel] = None
        self._label: Optional[tk.Label] = None
        widget.bind("<Enter>", self._on_enter, add="+")
        widget.bind("<Leave>", self._on_leave, add="+")
        widget.bind("<ButtonPress>", self._on_leave, add="+")

    # ---- public helpers --------------------------------------------------

    def update_text(self, text: str) -> None:
        """Replace the tooltip body text. Live update if currently shown."""
        self._text = text or ""
        if self._tip is not None and self._label is not None:
            try:
                self._label.configure(text=self._text)
            except tk.TclError:
                # Widget was destroyed mid-render; quietly drop.
                self._tip = None
                self._label = None

    def destroy(self) -> None:
        """Detach handlers and tear down any visible tip. Safe to call twice."""
        self._cancel_pending()
        self._hide()

    # ---- event handlers --------------------------------------------------

    def _on_enter(self, _event: object = None) -> None:
        self._cancel_pending()
        if not self._text:
            return
        self._after_id = self._widget.after(self._delay_ms, self._show)

    def _on_leave(self, _event: object = None) -> None:
        self._cancel_pending()
        self._hide()

    def _cancel_pending(self) -> None:
        if self._after_id is not None:
            try:
                self._widget.after_cancel(self._after_id)
            except tk.TclError:
                pass
            self._after_id = None

    # ---- show / hide ----------------------------------------------------

    def _show(self) -> None:
        if self._tip is not None or not self._text:
            return
        try:
            x = self._widget.winfo_rootx() + 14
            y = self._widget.winfo_rooty() + self._widget.winfo_height() + 6
        except tk.TclError:
            return
        try:
            tip = tk.Toplevel(self._widget)
        except tk.TclError:
            return
        tip.wm_overrideredirect(True)
        try:
            tip.attributes("-topmost", True)
        except tk.TclError:
            pass
        tip.geometry(f"+{x}+{y}")
        # Plain tk.Label keeps the dependency surface tiny - no ctk import
        # needed and the borderless overlay renders identically.
        label = tk.Label(
            tip,
            text=self._text,
            justify="left",
            background="#1f1f1f",
            foreground="#e6e6e6",
            relief="solid",
            borderwidth=1,
            font=("Arial", 10),
            padx=8,
            pady=4,
        )
        label.pack()
        self._tip = tip
        self._label = label

    def _hide(self) -> None:
        if self._tip is not None:
            try:
                self._tip.destroy()
            except tk.TclError:
                pass
        self._tip = None
        self._label = None
