"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCard({
  value,
  title,
  subtitle,
}: {
  value: string;
  title: string;
  subtitle?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, { width: 256, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [value]);

  return (
    <div className="flex flex-col items-center gap-3">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt={title}
          width={256}
          height={256}
          className="rounded-xl bg-white p-2 shadow-sm"
        />
      ) : (
        <div className="h-64 w-64 animate-pulse rounded-xl bg-zinc-200" />
      )}
      <p className="font-bold">{title}</p>
      {subtitle && <p className="text-sm opacity-70">{subtitle}</p>}
    </div>
  );
}
