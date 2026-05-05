"use client";

import {
  cloneElement,
  isValidElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * Field — wraps a label + control + optional hint + error.
 * Wires aria-describedby/aria-invalid onto the child automatically
 * when the child is a single React element.
 */
export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  htmlFor,
  children,
  className = "",
  ...rest
}: FieldProps) {
  const reactId = useId();
  const controlId = htmlFor ?? reactId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy =
    [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const wired = wireControl(children, controlId, {
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  });

  return (
    <div
      className={["flex flex-col gap-1.5", className].filter(Boolean).join(" ")}
      {...rest}
    >
      <label
        htmlFor={controlId}
        className="text-caption font-medium text-text"
      >
        {label}
        {required ? (
          <span aria-hidden className="ml-1 text-danger">*</span>
        ) : null}
      </label>
      {wired}
      {hint && !error ? (
        <p id={hintId} className="text-caption text-text-dim">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-caption text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function wireControl(
  child: ReactNode,
  id: string,
  extra: Record<string, unknown>,
): ReactNode {
  if (!isValidElement(child)) return child;
  const el = child as ReactElement<Record<string, unknown>>;
  return cloneElement(el, {
    id: el.props.id ?? id,
    ...extra,
  });
}
