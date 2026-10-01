import { useEffect } from "react";
import type { PhoneInfo } from "../api.ts";

/** Shown on the Mac: how to open bench_bot on a phone in the same Wi-Fi. */
export function PhonePanel({
  info,
  onClose,
}: {
  info: Extract<PhoneInfo, { enabled: true }>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Open on your phone">
        <header className="pane-head">
          <span className="pane-title">Open on your phone</span>
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="dialog-body">
          {info.qrSvg && (
            <img
              className="qr"
              alt="QR code that opens bench_bot on your phone"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(info.qrSvg)}`}
            />
          )}
          <p>Scan with the phone camera (same Wi-Fi). It logs in directly.</p>
          <p className="muted">
            Or open{" "}
            {info.urls.map((u) => (
              <code key={u}>{u}</code>
            ))}{" "}
            and enter the password <code>{info.password}</code>
          </p>
          {info.urls.length === 0 && (
            <p className="note note-blocked">No home network found. Is this Mac on Wi-Fi?</p>
          )}
        </div>
      </div>
    </div>
  );
}
