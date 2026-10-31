/** The Claude spark mark, drawn as 12 strokes so it inherits the current stroke colour. */
export default function Spark({ className, weight = 1 }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      {Array.from({ length: 12 }, (_, k) => {
        const angle = ((k * 30 - 90 + (k % 2 ? 6 : 0)) * Math.PI) / 180;
        const len = k % 2 ? 30 : 42;
        return <line key={k} x1="50" y1="50" x2={50 + Math.cos(angle) * len} y2={50 + Math.sin(angle) * len} strokeWidth={(k % 2 ? 8 : 10) * weight} />;
      })}
    </svg>
  );
}
