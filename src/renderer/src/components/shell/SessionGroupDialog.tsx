import type { SessionGroup } from "@shared/settings.js";
import type React from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { FadeText } from "../common/FadeText.js";
import { IconFolder } from "../common/icons.js";
import "./ConfirmDialog.css";
import "./SessionGroupDialog.css";

interface SessionGroupDialogProps {
  mode: "create" | "rename" | "move";
  initialValue: string;
  groups: SessionGroup[];
  subject?: string | undefined;
  returnFocus: HTMLElement;
  fallbackFocus: () => HTMLElement | null;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
  onCreate?: (() => void) | undefined;
}

/** App-owned settings editor: it never activates, renames, or moves a Pi session. */
export function SessionGroupDialog({
  mode,
  initialValue,
  groups,
  subject,
  returnFocus,
  fallbackFocus,
  onSave,
  onClose,
  onCreate,
}: SessionGroupDialogProps): React.ReactElement {
  const titleId = useId();
  const fieldId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const isMove = mode === "move";
  const title = isMove
    ? "Move session to group"
    : mode === "rename"
      ? "Rename group"
      : "New session group";

  useEscapeClaim(true);
  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    if (busy) {
      // Disabling the focused control otherwise drops focus into the page,
      // outside the form's keyboard trap. Retain it on the dialog while saving.
      form.focus();
      return;
    }
    const input = form.querySelector<HTMLInputElement>(
      'input[type="text"], input[type="radio"]:checked',
    );
    input?.focus();
    if (input?.type === "text") input.select();
  }, [busy]);

  const close = (): void => {
    if (savingRef.current) return;
    onClose();
    const restore = (): void => {
      const target = returnFocus.isConnected ? returnFocus : fallbackFocus();
      target?.focus();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else queueMicrotask(restore);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLFormElement>): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      const controls = formRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="radio"]), input[type="radio"]:checked:not(:disabled)',
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const save = async (): Promise<void> => {
    if (savingRef.current || (!isMove && !value.trim())) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(isMove ? value : value.trim());
      savingRef.current = false;
      close();
    } catch {
      savingRef.current = false;
      setBusy(false);
      setError("Couldn’t save sidebar changes. Please try again.");
    }
  };

  return createPortal(
    <div
      className="confirm-dialog-scrim"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <form
        ref={formRef}
        className="confirm-dialog session-group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="confirm-dialog__header">
          <div className="confirm-dialog__icon">
            <IconFolder />
          </div>
          <div className="confirm-dialog__heading">
            <h2 className="confirm-dialog__title" id={titleId}>
              {title}
            </h2>
            {subject && <FadeText className="confirm-dialog__subject">{subject}</FadeText>}
          </div>
        </div>
        {isMove ? (
          <fieldset className="session-group-dialog__choices" disabled={busy}>
            <legend className="session-group-dialog__label">Session group</legend>
            {[{ id: "", name: "Ungrouped" }, ...groups].map((group) => (
              <label key={group.id} className="session-group-dialog__choice fade-scope">
                <input
                  type="radio"
                  name={fieldId}
                  value={group.id}
                  checked={value === group.id}
                  onChange={() => setValue(group.id)}
                />
                <FadeText>{group.name}</FadeText>
              </label>
            ))}
          </fieldset>
        ) : (
          <label className="session-group-dialog__field" htmlFor={fieldId}>
            <span className="session-group-dialog__label">Group name</span>
            <input
              id={fieldId}
              type="text"
              className="session-group-dialog__input"
              value={value}
              maxLength={80}
              required
              disabled={busy}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
        )}
        {error && (
          <p className="session-group-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-dialog__actions">
          {isMove && onCreate && (
            <button
              type="button"
              className="session-group-dialog__create"
              disabled={busy}
              onClick={onCreate}
            >
              New group
            </button>
          )}
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="confirm-dialog__btn confirm-dialog__btn--confirm"
            disabled={busy || (!isMove && !value.trim())}
          >
            {busy ? "Saving…" : isMove ? "Move" : mode === "rename" ? "Save" : "Create group"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
