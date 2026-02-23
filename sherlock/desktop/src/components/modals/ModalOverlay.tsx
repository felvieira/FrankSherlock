import { useEffect } from "react";

type Props = {
  children: React.ReactNode;
  className?: string;
  onBackdropClick?: () => void;
  onEscape?: () => void;
};

export default function ModalOverlay({ children, className, onBackdropClick, onEscape }: Props) {
  const handler = onEscape ?? onBackdropClick;

  useEffect(() => {
    if (!handler) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handler!();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handler]);

  return (
    <div
      className={`modal-overlay${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      onClick={onBackdropClick}
    >
      {children}
    </div>
  );
}
