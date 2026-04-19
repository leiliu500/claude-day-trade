function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

export interface BSInputs {
  S: number;
  K: number;
  T: number;
  r: number;
  sigma: number;
  type: "C" | "P";
}

export function bsPrice({ S, K, T, r, sigma, type }: BSInputs): number {
  if (T <= 0 || sigma <= 0) {
    return type === "C" ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === "C") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

export function bsDelta({ S, K, T, r, sigma, type }: BSInputs): number {
  if (T <= 0 || sigma <= 0) {
    if (type === "C") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return type === "C" ? normCdf(d1) : normCdf(d1) - 1;
}

export function strikeForTargetDelta(
  S: number,
  T: number,
  r: number,
  sigma: number,
  type: "C" | "P",
  targetDelta: number,
  strikeStep: number,
): number {
  const target = type === "C" ? Math.abs(targetDelta) : -Math.abs(targetDelta);
  let lo = S * 0.5;
  let hi = S * 1.5;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const d = bsDelta({ S, K: mid, T, r, sigma, type });
    if (type === "C") {
      if (d > target) lo = mid;
      else hi = mid;
    } else {
      if (d > target) lo = mid;
      else hi = mid;
    }
    if (Math.abs(d - target) < 0.001) break;
  }
  const raw = (lo + hi) / 2;
  return Math.round(raw / strikeStep) * strikeStep;
}
