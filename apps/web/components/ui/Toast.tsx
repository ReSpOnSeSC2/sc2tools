"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

/**
 * Toast — transient notifications anchored bottom-right (desktop) / bottom (mobile).
 *
 * Wrap a subtree in <ToastProvider>, then call useToast() from descendants:
 *   const { toast } = useToast();
 *   toast.success("Saved");
 *   toast.error("Couldn't save", { description: err.message });
 *
 * Each toast auto-dismisses after `duration` ms (default 4000) unless
 * `duration === null`. The dismiss button + Esc-on-focus close it manually.
 */

export type ToastVariant = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: ReactNode;
  description?: ReactNode;
  duration: number | null;
}

interface ToastInput {
  description?: ReactNode;
  duration?: number | null;
}

interface ToastApi {
  show: (
    variant: ToastVariant,
    title: ReactNode,
    input?: ToastInput,
  ) => string;
  info: (title: ReactNode, input?: ToastInput) => string;
  success: (title: ReactNode, input?: ToastInput) => string;
  warning: (title: ReactNode, input?: ToastInput) => string;
  error: (title: ReactNode, input?: ToastInput) => string;
  dismiss: (id: string) => void;
}

interface ToastContextValue {
  toast: ToastApi;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>.");
  return ctx;
}

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: "border-accent/40 bg-bg-surface",
  success: "border-success/40 bg-bg-surface",
  warning: "border-warning/40 bg-bg-surface",
  error: "border-danger/40 bg-bg-surface",
};

const VARIANT_ICON_CLASSES: Record<ToastVariant, string> = {
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
};

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const cls = `h-5 w-5 ${VARIANT_ICON_CLASSES[variant]}`;
  if (variant === "success") return <CheckCircle2 className={cls} aria-hidden />;
  if (variant === "error" || variant === "warning")
    return <AlertCircle className={cls} aria-hidden />;
  return <Info className={cls} aria-hidden />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const handle = timersRef.current.get(id);
    if (handle) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (
      variant: ToastVariant,
      title: ReactNode,
      input?: ToastInput,
    ): string => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const duration = input?.duration === undefined ? 4000 : input.duration;
      const next: ToastItem = {
        id,
        variant,
        title,
        description: input?.description,
        duration,
      };
      setItems((prev) => [...prev, next]);
      if (duration !== null) {
        const handle = window.setTimeout(() => {
          dismiss(id);
        }, duration);
        timersRef.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    return () => {
      for (const handle of timersRef.current.values()) {
        window.clearTimeout(handle);
      }
      timersRef.current.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      info: (title, input) => show("info", title, input),
      success: (title, input) => show("success", title, input),
      warning: (title, input) => show("warning", title, input),
      error: (title, input) => show("error", title, input),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast: api }}>
      {children}
      {mounted
        ? createPortal(
            <div
              role="region"
              aria-label="Notifications"
              className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-stretch gap-2 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
            >
              {items.map((t) => (
                <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  return (
    <div
      role={item.variant === "error" ? "alert" : "status"}
      aria-live={item.variant === "error" ? "assertive" : "polite"}
      className={[
        "pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-[var(--shadow-card)]",
        VARIANT_CLASSES[item.variant],
      ].join(" ")}
    >
      <VariantIcon variant={item.variant} />
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold text-text">{item.title}</div>
        {item.description ? (
          <div className="mt-0.5 text-caption text-text-muted">
            {item.description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-mr-1 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
