import { memo } from 'react';

// Built-in pixel mascots (12x10 grids). Servers can only pick a preset name + colour, never markup.
const PIXELS = {
  CLAUDE_CRAB: ['..########..', '..########..', '..#.####.#..', '############', '############', '..########..', '..#.#..#.#..', '..#.#..#.#..'],
  CLAUDE_GHOST: ['...######...', '..########..', '.##.####.##.', '.##########.', '.##########.', '.##########.', '.#.##..##.#.', '.#..#..#..#.'],
  CLAUDE_BOT: ['.....##.....', '..########..', '.#........#.', '.#.##..##.#.', '.#........#.', '.#..####..#.', '..########..', '...#....#...'],
  CLAUDE_CAT: ['.#........#.', '.##......##.', '.##########.', '.#.##..##.#.', '.##########.', '.####..####.', '..########..', '..#......#..'],
};

export const AVATAR_PRESETS = Object.keys(PIXELS);

export const COLOR_PALETTE = [
  { id: 'terracotta', hex: '#D97757' },
  { id: 'sky', hex: '#6EA8FE' },
  { id: 'violet', hex: '#B07CFF' },
  { id: 'amber', hex: '#E9A23B' },
  { id: 'mint', hex: '#52B788' },
  { id: 'coral', hex: '#FF6B6B' },
  { id: 'teal', hex: '#4FD1C5' },
  { id: 'peach', hex: '#F39C7F' },
];

const rectsCache = {};
function rectsFor(preset) {
  if (!rectsCache[preset]) {
    const grid = PIXELS[preset] || PIXELS.CLAUDE_CRAB;
    const out = [];
    grid.forEach((row, y) => [...row].forEach((c, x) => c === '#' && out.push(`M${x} ${y}h1v1h-1z`)));
    rectsCache[preset] = out.join('');
  }
  return rectsCache[preset];
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

export const OperatorSvgIcon = memo(function OperatorSvgIcon({
  color = '#D97757',
  preset = 'CLAUDE_CRAB',
  status = 'IDLE',
  isOnline = true,
  size = 22,
  showStatusDot = true,
}) {
  const off = !isOnline || status === 'OFFLINE';
  const stateClass = off
    ? 'claude-svg--offline'
    : status === 'OVERHEAT'
      ? 'claude-svg--overheat'
      : status === 'WORKING'
        ? 'claude-svg--working'
        : 'claude-svg--idle';
  const dotClass = off
    ? 'status-dot--offline'
    : status === 'OVERHEAT'
      ? 'status-dot--overheat'
      : status === 'WORKING'
        ? 'status-dot--working'
        : 'status-dot--online';
  const fill = SAFE_COLOR.test(color || '') ? color : '#D97757';
  return (
    <div
      className="claude-avatar-wrap"
      style={{ width: size + 12, height: size + 12, minWidth: size + 12, borderColor: !off && status === 'WORKING' ? fill : undefined }}
    >
      <svg viewBox="0 -2 12 12" className={`claude-svg ${stateClass}`} style={{ width: size, height: size }} shapeRendering="crispEdges" aria-hidden="true">
        <path fill={fill} d={rectsFor(preset)} />
      </svg>
      {showStatusDot && <span className={`status-dot ${dotClass}`} />}
    </div>
  );
});
