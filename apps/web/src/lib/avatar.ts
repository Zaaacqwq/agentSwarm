/** Deterministic avatar traits from an agent's seed, so the same agent always looks the same. */
export interface AvatarTraits {
  readonly hue: number;
  readonly eyes: 0 | 1 | 2 | 3;
  readonly mouth: 0 | 1 | 2 | 3;
  readonly tilt: number;
  readonly cheeks: boolean;
}

export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarTraits(seed: string): AvatarTraits {
  const h = hashSeed(seed);
  return {
    hue: h % 360,
    eyes: ((h >>> 9) % 4) as AvatarTraits["eyes"],
    mouth: ((h >>> 13) % 4) as AvatarTraits["mouth"],
    tilt: ((h >>> 17) % 9) - 4,
    cheeks: ((h >>> 21) & 1) === 1,
  };
}
