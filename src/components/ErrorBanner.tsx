/** A failure the user should see, on whichever screen they are on; click to dismiss. */
export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="banner error" role="alert" onClick={onDismiss}>
      {message} <span className="muted small">(click to dismiss)</span>
    </div>
  );
}
