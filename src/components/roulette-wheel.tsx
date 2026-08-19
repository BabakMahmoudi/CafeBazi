export type RouletteSlot = {
  emoji: string;
  labelKey: string;
};

const PALETTE = ["#faf6f0", "var(--accent)", "var(--accent-soft)", "#241a12"];

function fillFor(slot: RouletteSlot, index: number): string {
  return slot.labelKey === "jackpot" ? "#d4af37" : PALETTE[index % PALETTE.length];
}

export function RouletteWheel({
  slots,
  size = 280,
  spinDeg = 0,
}: {
  slots: RouletteSlot[];
  size?: number;
  spinDeg?: number;
}) {
  const count = slots.length;
  const segment = 360 / count;
  const cx = 100;
  const cy = 100;
  const r = 92;
  const rad = (degrees: number) => (degrees * Math.PI) / 180;

  const segments = slots.map((slot, index) => {
    const start = -90 + index * segment;
    const end = start + segment;
    const x1 = cx + r * Math.cos(rad(start));
    const y1 = cy + r * Math.sin(rad(start));
    const x2 = cx + r * Math.cos(rad(end));
    const y2 = cy + r * Math.sin(rad(end));
    const mid = start + segment / 2;
    return {
      slot,
      d: `M ${cx} ${cy} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`,
      emojiX: cx + 60 * Math.cos(rad(mid)),
      emojiY: cy + 60 * Math.sin(rad(mid)),
    };
  });

  return (
    <div
      data-testid="roulette-wheel"
      className="relative select-none"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 rounded-full shadow-lg"
        style={{
          transform: `rotate(${spinDeg}deg)`,
          transition: "transform 4.5s cubic-bezier(0.12, 0.8, 0.18, 1)",
          willChange: "transform",
        }}
      >
        <svg viewBox="0 0 200 200" width={size} height={size} className="block">
          {segments.map(({ slot, d, emojiX, emojiY }, index) => (
            <g key={index}>
              <path d={d} fill={fillFor(slot, index)} stroke="#241a12" strokeWidth={1.5} />
              <text
                x={emojiX}
                y={emojiY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={24}
              >
                {slot.emoji}
              </text>
            </g>
          ))}
          <circle cx={cx} cy={cy} r={20} fill="#241a12" />
          <circle cx={cx} cy={cy} r={9} fill="var(--accent)" />
        </svg>
      </div>
      <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/3">
        <svg width={30} height={24} viewBox="0 0 30 24">
          <polygon points="15,22 2,2 28,2" fill="var(--accent)" stroke="#241a12" strokeWidth={1} />
        </svg>
      </div>
    </div>
  );
}
